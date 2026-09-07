"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  decodeSevenZipListing,
  listingEncoding,
} = require("./code-page");
const {
  hasPasswordSwitch,
} = require("./sevenzip");

const SYSTEM_COMMANDS = ["7zzs", "7zz", "7z", "7za", "7zr"];

function executableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    fs.accessSync(filePath, fs.constants.X_OK);
    return stat.isFile();
  } catch (error) {
    return false;
  }
}

function findSevenZip(options = {}) {
  const envPath = options.envPath || process.env.FNSMARTZIP_SEVENZIP_PATH;
  if (envPath && executableFile(envPath)) {
    return { path: envPath, source: "env" };
  }

  const vendorRoot = options.vendorRoot
    || path.resolve(__dirname, "..", "..", "vendor", "7zip");
  const archDir = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  for (const binary of ["7zzs", "7zz"]) {
    const bundledPath = path.join(vendorRoot, archDir, binary);
    if (executableFile(bundledPath)) {
      return { path: bundledPath, source: "bundled" };
    }
  }

  for (const command of SYSTEM_COMMANDS) {
    const result = spawnSync("sh", ["-c", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return {
        path: result.stdout.trim().split(/\r?\n/)[0],
        source: "system",
      };
    }
  }

  return null;
}

function classifySevenZipError(log, exitCode, context = {}) {
  const text = String(log || "").toLowerCase();
  if (exitCode === 255 && context.cancelled) {
    return { code: "CANCELLED", message: "任务已取消" };
  }
  if (
    !context.passwordProvided
    && (
      /enter password|password.*required|can not open encrypted/.test(text)
      || (exitCode === 255 && /password/.test(text))
    )
  ) {
    return { code: "PASSWORD_REQUIRED", message: "压缩包需要密码" };
  }
  if (/wrong password|password is incorrect|encrypted.*password|can not open encrypted/.test(text)) {
    return { code: "PASSWORD", message: "密码错误或压缩包需要密码" };
  }
  if (/missing volume|unexpected end of archive|can't open as archive: 1/.test(text)) {
    return { code: "MISSING_VOLUME", message: "分卷缺失或顺序不完整" };
  }
  if (/permission denied|errno=13|access is denied/.test(text)) {
    return { code: "PERMISSION", message: "应用没有读取或写入权限" };
  }
  if (/can not open.*as archive|is not archive|unsupported method/.test(text)) {
    return { code: "UNSUPPORTED", message: "文件格式不受支持或扩展名不正确" };
  }
  if (/data error|crc failed|headers error|unexpected end of data/.test(text)) {
    if (context.passwordProvided) {
      return { code: "PASSWORD", message: "密码错误或压缩包需要密码" };
    }
    return { code: "DAMAGED", message: "压缩包已损坏或数据校验失败" };
  }
  if (exitCode === 255) {
    if (context.phase === "preview") {
      return {
        code: "PREVIEW_INTERRUPTED",
        message: "压缩包预览被系统中断，可尝试整包解压",
      };
    }
    return {
      code: "ENGINE_INTERRUPTED",
      message: "7-Zip 进程被系统中断",
    };
  }
  return {
    code: "ENGINE",
    message: `7-Zip 执行失败${exitCode == null ? "" : `（退出码 ${exitCode}）`}`,
  };
}

function parseProgress(log) {
  const text = String(log || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = text.split(/\r\n|\n|\r/);
  let percent = 0;
  let currentFile = "";
  for (const line of lines) {
    const compactLine = line.trim();
    const inlineProgress = compactLine.match(/^(\d{1,3})%\s+(?:\d+\s+-\s+)?(.+)?$/);
    if (inlineProgress) {
      percent = Math.min(100, Number(inlineProgress[1]));
      if (inlineProgress[2]) {
        currentFile = inlineProgress[2].trim();
      }
      continue;
    }
    const standaloneProgress = compactLine.match(/^(\d{1,3})%$/);
    if (standaloneProgress) {
      percent = Math.min(100, Number(standaloneProgress[1]));
      continue;
    }
    const fileLine = compactLine.match(/^-\s+(.+)$/);
    if (fileLine) {
      currentFile = fileLine[1].trim();
    }
  }

  if (text.includes("\x08")) {
    const terminalProgress = /(?:^|\x08+)[\x08 ]*(\d{1,3})%\s*(?:(\d+\s+-|-|[TEX])\s+)?([^\r\n\x08]*)/g;
    for (const match of text.matchAll(terminalProgress)) {
      percent = Math.max(percent, Math.min(100, Number(match[1])));
      const fileName = String(match[3] || "").trim();
      if (match[2] && fileName) {
        currentFile = fileName;
      }
    }
    for (const match of text.matchAll(/\x08+-\s+([^\r\n\x08]+)/g)) {
      currentFile = match[1].trim();
    }
  }
  return { percent, currentFile };
}

function sevenZipEnv(options = {}) {
  return {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
    ...(options.env || {}),
  };
}

function decodeOutput(buffer, options = {}) {
  if (buffer == null || buffer === "") {
    return "";
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8");
  return decodeSevenZipListing(bytes, options.codePage);
}

function passwordWasProvided(args, options = {}) {
  return Boolean(
    options.passwordProvided
    ?? (options.password || hasPasswordSwitch(args)),
  );
}

function writePasswordStdin(child, password) {
  if (!child?.stdin) {
    return;
  }
  if (password) {
    child.stdin.write(String(password));
    if (!String(password).endsWith("\n")) {
      child.stdin.write("\n");
    }
  }
  child.stdin.end();
}

function classifiedError(log, exitCode, args, options = {}) {
  const classified = classifySevenZipError(log, exitCode, {
    ...options,
    passwordProvided: passwordWasProvided(args, options),
  });
  const error = new Error(classified.message);
  error.code = classified.code;
  error.exitCode = exitCode;
  error.log = log;
  return error;
}

function runSevenZipSync(tool, args, options = {}) {
  const result = spawnSync(tool.path, args, {
    cwd: options.cwd,
    env: sevenZipEnv(options),
    input: options.password ? `${options.password}\n` : undefined,
    encoding: null,
    timeout: options.timeout || 10 * 60 * 1000,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = decodeOutput(result.stdout, options);
  const stderr = decodeOutput(result.stderr, options);
  const log = `${stdout}${stderr}`;
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      const error = new Error("压缩包预览输出超过大小限制");
      error.code = "PREVIEW_LIMIT";
      error.cause = result.error;
      throw error;
    }
    if (result.error.code === "ETIMEDOUT" && options.phase === "preview") {
      const error = new Error("压缩包预览超时，可尝试整包解压");
      error.code = "PREVIEW_INTERRUPTED";
      error.cause = result.error;
      throw error;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw classifiedError(log, result.status, args, options);
  }
  return { exitCode: result.status, log, stdout, stderr };
}

function runSevenZipValidateSync(tool, args, options = {}) {
  const helperPath = path.join(__dirname, "listing-validator.js");
  const env = sevenZipEnv({
    env: {
      ...options.env,
      FNSMARTZIP_LISTING_ENCODING: listingEncoding(options.codePage),
    },
  });
  const result = spawnSync(process.execPath, [
    helperPath,
    tool.path,
    options.cwd || "",
    ...args,
  ], {
    env,
    input: options.password ? `${options.password}\n` : "",
    encoding: "utf8",
    timeout: options.timeout || 10 * 60 * 1000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw classifiedError(result.stderr || log, result.status, args, options);
  }
  return JSON.parse(result.stdout || "{}");
}

function spawnSevenZip(tool, args, options = {}) {
  const child = spawn(tool.path, args, {
    cwd: options.cwd,
    env: sevenZipEnv(options),
    detached: options.detached !== false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  writePasswordStdin(child, options.password);
  return child;
}

module.exports = {
  classifySevenZipError,
  executableFile,
  findSevenZip,
  parseProgress,
  runSevenZipSync,
  runSevenZipValidateSync,
  spawnSevenZip,
  writePasswordStdin,
};
