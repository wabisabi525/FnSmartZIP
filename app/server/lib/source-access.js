"use strict";

const fs = require("node:fs");
const path = require("node:path");

function modeString(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function sourceMessage(code, filePath) {
  const name = path.basename(filePath) || filePath;
  if (code === "SOURCE_NOT_FOUND") {
    return `源文件不存在：${name}`;
  }
  if (code === "SOURCE_PARENT_DENIED") {
    return `应用无法遍历源文件所在目录：${filePath}`;
  }
  if (code === "SOURCE_FILE_DENIED") {
    return `应用无法读取源文件：${name}（请检查现有文件 ACL，目录授权不等于文件 ACL 已更新）`;
  }
  if (code === "SOURCE_REALPATH_FAILED") {
    return `无法解析源文件真实路径：${filePath}`;
  }
  return `源路径不可用：${filePath}`;
}

function classifySourceError(error, filePath, stage = "file") {
  let code = "SOURCE_REALPATH_FAILED";
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    code = "SOURCE_NOT_FOUND";
  } else if (error?.code === "EACCES" || error?.code === "EPERM") {
    code = stage === "parent"
      ? "SOURCE_PARENT_DENIED"
      : "SOURCE_FILE_DENIED";
  }
  const classified = new Error(sourceMessage(code, filePath));
  classified.code = code;
  classified.errno = error?.errno ?? null;
  classified.syscall = error?.syscall || "";
  classified.path = filePath;
  classified.cause = error;
  return classified;
}

function identity(options = {}) {
  const getuid = options.getuid || process.getuid?.bind(process);
  const getgid = options.getgid || process.getgid?.bind(process);
  const getgroups = options.getgroups || process.getgroups?.bind(process);
  return {
    uid: typeof getuid === "function" ? getuid() : null,
    gid: typeof getgid === "function" ? getgid() : null,
    groups: typeof getgroups === "function" ? getgroups() : [],
  };
}

function pathComponents(absolutePath, pathModule = path) {
  const parsed = pathModule.parse(absolutePath);
  const parts = absolutePath
    .slice(parsed.root.length)
    .split(pathModule.sep)
    .filter(Boolean);
  const components = [];
  let current = parsed.root;
  if (current) {
    components.push(current);
  }
  for (const part of parts.slice(0, -1)) {
    current = pathModule.join(current, part);
    components.push(current);
  }
  return components;
}

function statReport(filePath, stat, type, accessible) {
  return {
    path: filePath,
    type,
    mode: modeString(stat.mode),
    uid: Number.isFinite(stat.uid) ? stat.uid : null,
    gid: Number.isFinite(stat.gid) ? stat.gid : null,
    accessible,
  };
}

function inspectSourceFile(filePath, options = {}) {
  const fsModule = options.fsModule || fs;
  const pathModule = options.pathModule || path;
  const application = identity(options);
  if (!filePath || typeof filePath !== "string" || !pathModule.isAbsolute(filePath)) {
    const error = new Error("源文件路径必须是绝对路径");
    error.code = "SOURCE_PATH_INVALID";
    throw error;
  }

  const components = [];
  for (const component of pathComponents(
    pathModule.resolve(filePath),
    pathModule,
  )) {
    let stat;
    try {
      stat = fsModule.statSync(component);
      if (stat.isDirectory()) {
        fsModule.accessSync(component, fs.constants.X_OK);
      }
      components.push(statReport(component, stat, "directory", true));
    } catch (error) {
      if (stat) {
        components.push(statReport(component, stat, "directory", false));
      }
      const classified = classifySourceError(error, component, "parent");
      classified.diagnostic = {
        application,
        components,
      };
      throw classified;
    }
  }

  let resolved;
  try {
    resolved = fsModule.realpathSync(filePath);
  } catch (error) {
    const classified = classifySourceError(error, filePath, "realpath");
    classified.diagnostic = {
      application,
      components,
    };
    throw classified;
  }

  let stat;
  try {
    stat = fsModule.statSync(resolved);
    if (!stat.isFile()) {
      const error = new Error("源路径不是普通文件");
      error.code = "SOURCE_NOT_FILE";
      error.path = resolved;
      throw error;
    }
    fsModule.accessSync(resolved, fs.constants.R_OK);
  } catch (error) {
    if (error.code === "SOURCE_NOT_FILE") {
      throw error;
    }
    if (stat) {
      components.push(statReport(resolved, stat, "file", false));
    }
    const classified = classifySourceError(error, resolved, "file");
    classified.diagnostic = {
      application,
      components,
    };
    throw classified;
  }

  components.push(statReport(resolved, stat, "file", true));
  return {
    path: resolved,
    readable: true,
    mode: modeString(stat.mode),
    uid: Number.isFinite(stat.uid) ? stat.uid : null,
    gid: Number.isFinite(stat.gid) ? stat.gid : null,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    application,
    components,
    stat,
  };
}

module.exports = {
  classifySourceError,
  inspectSourceFile,
  modeString,
};
