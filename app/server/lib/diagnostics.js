"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REDACTED = "[REDACTED]";

function redactString(value) {
  return value.replace(
    /(^|[\s"'=:,[({])-p(?:"[^"]*"|'[^']*'|[^\s"',}\])]+)/gs,
    `$1-p${REDACTED}`,
  );
}

function redactDiagnosticValue(value, key = "") {
  const normalizedKey = String(key).toLowerCase();
  if (
    normalizedKey.includes("password")
    || normalizedKey.includes("secret")
  ) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (
      typeof entry === "string"
        ? redactString(entry)
        : redactDiagnosticValue(entry)
    ));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return typeof value === "string" ? redactString(value) : value;
}

class DiagnosticLogger {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    this.maxBytes = options.maxBytes || 2 * 1024 * 1024;
    this.backups = options.backups ?? 3;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.rootDir, 0o700);
    } catch (error) {
      // Some filesystems do not expose POSIX modes.
    }
    this.logPath = path.join(this.rootDir, "fnsmartzip.log");
    this.lockPath = `${this.logPath}.lock`;
  }

  withLock(callback) {
    let descriptor;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        descriptor = fs.openSync(this.lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > 30 * 1000) {
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") {
            throw statError;
          }
        }
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, 5);
      }
    }
    if (descriptor == null) {
      const error = new Error("诊断日志文件正忙");
      error.code = "LOG_BUSY";
      throw error;
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  rotateIfNeeded(nextBytes) {
    let currentBytes = 0;
    try {
      currentBytes = fs.statSync(this.logPath).size;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (currentBytes + nextBytes <= this.maxBytes) {
      return;
    }
    for (let index = this.backups; index >= 1; index -= 1) {
      const destination = `${this.logPath}.${index}`;
      const source = index === 1
        ? this.logPath
        : `${this.logPath}.${index - 1}`;
      fs.rmSync(destination, { force: true });
      if (fs.existsSync(source)) {
        fs.renameSync(source, destination);
      }
    }
  }

  write(event) {
    const record = {
      timestamp: new Date().toISOString(),
      ...redactDiagnosticValue(event),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.withLock(() => {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.logPath, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        fs.chmodSync(this.logPath, 0o600);
      } catch (error) {
        // Some filesystems do not expose POSIX modes.
      }
    });
    return record;
  }

  tail(maxBytes = 64 * 1024) {
    return this.tailFile(this.logPath, maxBytes);
  }

  tailFile(filePath, maxBytes = 64 * 1024) {
    try {
      const stat = fs.statSync(filePath);
      const length = Math.min(stat.size, maxBytes);
      const descriptor = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(descriptor, buffer, 0, length, stat.size - length);
        return buffer.toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  tailForRequest(requestId, maxBytes = 64 * 1024) {
    if (!requestId) {
      return "";
    }
    const logPaths = [];
    for (let index = this.backups; index >= 1; index -= 1) {
      logPaths.push(`${this.logPath}.${index}`);
    }
    logPaths.push(this.logPath);
    return logPaths
      .map((filePath) => this.tailFile(filePath, maxBytes))
      .filter(Boolean)
      .join("\n")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        try {
          return JSON.parse(line).requestId === requestId;
        } catch (error) {
          return false;
        }
      })
      .join("\n");
  }
}

class NullDiagnosticLogger {
  write(event) {
    return {
      timestamp: new Date().toISOString(),
      ...redactDiagnosticValue(event),
    };
  }

  tail() {
    return "";
  }

  tailForRequest() {
    return "";
  }
}

function createDiagnosticLogger(options = {}) {
  const roots = options.rootDirs || [options.rootDir].filter(Boolean);
  for (const rootDir of roots) {
    try {
      return new DiagnosticLogger({
        rootDir,
        maxBytes: options.maxBytes,
        backups: options.backups,
      });
    } catch (error) {
      // Try the next application-owned runtime directory.
    }
  }
  return new NullDiagnosticLogger();
}

function safeDiagnosticWrite(logger, event) {
  try {
    return logger?.write(event) || null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  createDiagnosticLogger,
  DiagnosticLogger,
  NullDiagnosticLogger,
  redactDiagnosticValue,
  safeDiagnosticWrite,
};
