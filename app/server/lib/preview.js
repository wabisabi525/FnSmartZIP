"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_MAX_ENTRIES = 100000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

class PreviewLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreviewLimitError";
    this.code = "PREVIEW_LIMIT";
  }
}

function normalizeEntryPath(value) {
  const raw = String(value || "");
  if (!raw || /[\0\r\n]/.test(raw)) {
    throw new Error("压缩包包含格式不安全的文件名");
  }

  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").includes("..")
  ) {
    throw new Error(`压缩包包含不安全路径：${raw}`);
  }

  return normalized.replace(/^\.\//, "");
}

function parseRecord(lines) {
  const record = {};
  for (const line of lines) {
    const separator = line.indexOf(" = ");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 3);
    record[key] = value;
  }
  return record;
}

function toNumber(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function normalizeTechnicalFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return format && format !== "split" ? format : null;
}

function detectTechnicalListFormat(text) {
  const header = String(text).split(/\n----------(?:\r?\n|$)/, 1)[0];
  const formats = header.split(/\r?\n/)
    .map((line) => line.match(/^Type = (.+)$/)?.[1])
    .map(normalizeTechnicalFormat)
    .filter(Boolean);
  return formats.at(-1) || null;
}

function parseTechnicalList(text, options = {}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PreviewLimitError("压缩包预览输出超过大小限制");
  }

  const lines = String(text).split(/\n/);
  const separatorIndex = lines.findIndex((line) => line.trim() === "----------");
  if (separatorIndex < 0) {
    return {
      entries: [],
      summary: {
        fileCount: 0,
        directoryCount: 0,
        totalSize: 0,
        encrypted: false,
      },
    };
  }

  const records = [];
  let current = [];
  for (const line of lines.slice(separatorIndex + 1)) {
    if (line === "") {
      if (current.length) {
        records.push(parseRecord(current));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) {
    records.push(parseRecord(current));
  }

  if (records.length > maxEntries) {
    throw new PreviewLimitError("压缩包文件数量超过预览限制");
  }

  const entries = records
    .filter((record) => record.Path)
    .map((record) => {
      const entryPath = normalizeEntryPath(record.Path);
      const slashIndex = entryPath.lastIndexOf("/");
      const attributes = String(record.Attributes || "");
      const isDirectory = record.Folder === "+"
        || /^D(?:\s|$)/i.test(attributes);
      return {
        path: entryPath,
        name: path.posix.basename(entryPath),
        parentPath: slashIndex >= 0 ? entryPath.slice(0, slashIndex) : "",
        type: isDirectory ? "directory" : "file",
        size: toNumber(record.Size),
        packedSize: toNumber(record["Packed Size"]),
        modified: record.Modified || "",
        encrypted: record.Encrypted === "+",
      };
    });

  const summary = entries.reduce(
    (result, entry) => {
      if (entry.type === "directory") {
        result.directoryCount += 1;
      } else {
        result.fileCount += 1;
        result.totalSize += entry.size;
      }
      result.encrypted ||= entry.encrypted;
      return result;
    },
    {
      fileCount: 0,
      directoryCount: 0,
      totalSize: 0,
      encrypted: false,
    },
  );

  return { entries, summary };
}

function createTechnicalListValidator(options = {}) {
  const maxLineBytes = options.maxLineBytes || 1024 * 1024;
  const maxRecordLines = options.maxRecordLines || 256;
  const maxRecordBytes = options.maxRecordBytes || 2 * 1024 * 1024;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let record = [];
  let afterSeparator = false;
  let entryCount = 0;
  let format = null;
  let recordBytes = 0;

  const flushRecord = () => {
    if (!record.length) {
      return;
    }
    const parsed = parseRecord(record);
    record = [];
    recordBytes = 0;
    if (parsed.Path) {
      normalizeEntryPath(parsed.Path);
      entryCount += 1;
    }
  };

  const processLine = (value) => {
    const line = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (!afterSeparator) {
      const type = line.match(/^Type = (.+)$/)?.[1];
      format = normalizeTechnicalFormat(type) || format;
      afterSeparator = line.trim() === "----------";
      return;
    }
    if (line === "") {
      flushRecord();
      return;
    }
    recordBytes += Buffer.byteLength(line, "utf8");
    if (
      record.length + 1 > maxRecordLines
      || recordBytes > maxRecordBytes
    ) {
      throw new Error("压缩包技术记录超过格式限制");
    }
    record.push(line);
  };

  const processPendingLines = () => {
    let newlineIndex;
    while ((newlineIndex = pending.indexOf("\n")) >= 0) {
      processLine(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
    }
    if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
      throw new Error("压缩包包含超长或格式异常的文件名");
    }
  };

  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      pending += decoder.write(buffer);
      processPendingLines();
    },
    end(chunk) {
      if (chunk != null) {
        this.write(chunk);
      }
      pending += decoder.end();
      processPendingLines();
      if (pending) {
        processLine(pending);
        pending = "";
      }
      flushRecord();
      return { entryCount, format };
    },
  };
}

function validateTechnicalListFile(filePath, options = {}) {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const validator = createTechnicalListValidator(options);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) {
        break;
      }
      validator.write(buffer.subarray(0, bytesRead));
    }
    return validator.end();
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  createTechnicalListValidator,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  detectTechnicalListFormat,
  PreviewLimitError,
  normalizeEntryPath,
  parseTechnicalList,
  validateTechnicalListFile,
};
