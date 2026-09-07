"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CODE_PAGE_ENCODINGS = Object.freeze({
  auto: "utf-8",
  utf8: "utf-8",
  gbk: "gbk",
  big5: "big5",
  shift_jis: "shift_jis",
  korean: "windows-949",
});

function normalizeCodePageId(value = "auto") {
  const id = String(value || "auto").toLowerCase();
  return Object.hasOwn(CODE_PAGE_ENCODINGS, id) ? id : "auto";
}

function listingEncoding(codePageId) {
  return CODE_PAGE_ENCODINGS[normalizeCodePageId(codePageId)] || "utf-8";
}

function shouldUseUtf8Console(codePageId) {
  const id = normalizeCodePageId(codePageId);
  return id === "auto" || id === "utf8";
}

function decodeSevenZipListing(buffer, codePageId) {
  const input = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(String(buffer || ""), "utf8");
  return new TextDecoder(listingEncoding(codePageId)).decode(input);
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch (error) {
    return false;
  }
}

function joinPathBytes(dir, nameBuffer) {
  const dirBuf = Buffer.from(String(dir), "utf8");
  const sep = Buffer.from(path.sep);
  if (dirBuf.length && dirBuf[dirBuf.length - 1] === sep[0]) {
    return Buffer.concat([dirBuf, nameBuffer]);
  }
  return Buffer.concat([dirBuf, sep, nameBuffer]);
}

function recodeDirectory(dir, encoding, fsModule) {
  const entries = fsModule.readdirSync(dir, {
    encoding: "buffer",
    withFileTypes: true,
  });
  let renamed = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.isBuffer(entry.name)
      ? entry.name
      : Buffer.from(String(entry.name), "utf8");
    const oldPath = joinPathBytes(dir, nameBuffer);
    if (entry.isDirectory()) {
      renamed += recodeDirectory(
        isValidUtf8(nameBuffer)
          ? path.join(dir, nameBuffer.toString("utf8"))
          : oldPath,
        encoding,
        fsModule,
      );
    }
    if (isValidUtf8(nameBuffer)) {
      continue;
    }
    const decoded = new TextDecoder(encoding).decode(nameBuffer).replace(/\0/g, "").trim();
    if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
      continue;
    }
    const newPath = path.join(dir, decoded);
    try {
      fsModule.statSync(newPath);
      continue;
    } catch (error) {
      fsModule.renameSync(oldPath, newPath);
      renamed += 1;
    }
  }
  return renamed;
}

function recodeExtractedTree(rootDir, codePageId, fsModule = fs) {
  if (!rootDir || shouldUseUtf8Console(codePageId)) {
    return 0;
  }
  return recodeDirectory(rootDir, listingEncoding(codePageId), fsModule);
}

module.exports = {
  decodeSevenZipListing,
  listingEncoding,
  normalizeCodePageId,
  recodeExtractedTree,
  shouldUseUtf8Console,
};
