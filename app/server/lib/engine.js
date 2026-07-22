"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

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
  const lines = String(log || "").split(/\r?\n/);
  let percent = 0;
  let currentFile = "";
  for (const line of lines) {
    const match = line.match(/\b(\d{1,3})%\s+(?:\d+\s+-\s+)?(.+)?$/);
    if (!match) {
      continue;
    }
    percent = Math.min(100, Number(match[1]));
    if (match[2]) {
      currentFile = match[2].trim();
    }
  }
  return { percent, currentFile };
}

function runSevenZipSync(tool, args, options = {}) {
  const result = spawnSync(tool.path, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout || 10 * 60 * 1000,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    windowsHide: true,
  });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      const error = new Error("压缩包预览输出超过大小限制");
      error.code = "PREVIEW_LIMIT";
      error.cause = result.error;
      throw error;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const classified = classifySevenZipError(log, result.status, {
      ...options,
      passwordProvided: options.passwordProvided
        ?? args.some((argument) => /^-p./s.test(argument)),
    });
    const error = new Error(classified.message);
    error.code = classified.code;
    error.exitCode = result.status;
    error.log = log;
    throw error;
  }
  return { exitCode: result.status, log, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runSevenZipValidateSync(tool, args, options = {}) {
  const helperPath = path.join(__dirname, "listing-validator.js");
  const result = spawnSync(process.execPath, [
    helperPath,
    tool.path,
    options.cwd || "",
    ...args,
  ], {
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
    const classified = classifySevenZipError(log, result.status, {
      ...options,
      passwordProvided: options.passwordProvided
        ?? args.some((argument) => /^-p./s.test(argument)),
    });
    const error = new Error(classified.message);
    error.code = classified.code;
    error.exitCode = result.status;
    error.log = log;
    throw error;
  }
  return JSON.parse(result.stdout || "{}");
}

function spawnSevenZip(tool, args, options = {}) {
  return spawn(tool.path, args, {
    cwd: options.cwd,
    detached: options.detached !== false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

module.exports = {
  classifySevenZipError,
  executableFile,
  findSevenZip,
  parseProgress,
  runSevenZipSync,
  runSevenZipValidateSync,
  spawnSevenZip,
};
