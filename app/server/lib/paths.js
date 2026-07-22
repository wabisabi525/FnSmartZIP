"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  collectAuthorizedPathCandidates,
  parsePathList,
} = require("./authorization-paths");

function normalizeForComparison(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(rootPath, candidatePath) {
  const root = normalizeForComparison(rootPath);
  const candidate = normalizeForComparison(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureDirectoryAccess(directoryPath) {
  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error("目标路径不是目录");
  }
  fs.accessSync(
    directoryPath,
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
}

function canAccess(directoryPath, mode) {
  try {
    fs.accessSync(directoryPath, mode);
    return true;
  } catch (error) {
    return false;
  }
}

function getDirectoryCapabilities(directoryPath) {
  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    return {
      canBrowse: false,
      canSelect: false,
    };
  }
  return {
    canBrowse: canAccess(directoryPath, fs.constants.R_OK | fs.constants.X_OK),
    canSelect: canAccess(directoryPath, fs.constants.W_OK | fs.constants.X_OK),
  };
}

function rootPath(root) {
  return typeof root === "string" ? root : root.path;
}

function realAuthorizedRoots(roots) {
  return roots.map((root) => {
    const resolved = fs.realpathSync(rootPath(root));
    return resolved;
  });
}

function resolveAuthorizedDirectory(candidatePath, roots) {
  if (!path.isAbsolute(candidatePath)) {
    throw new Error("目录必须使用绝对路径");
  }

  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
    ensureDirectoryAccess(resolved);
  } catch (error) {
    throw new Error("目录不存在或应用没有读写权限");
  }

  let authorizedRoots;
  try {
    authorizedRoots = realAuthorizedRoots(roots);
  } catch (error) {
    throw new Error("授权共享目录不可用");
  }
  if (!authorizedRoots.some((root) => isPathInside(root, resolved))) {
    throw new Error("目标目录不在应用授权的共享目录内");
  }
  return resolved;
}

function listAuthorizedDirectory(candidatePath, roots) {
  if (!path.isAbsolute(candidatePath)) {
    const error = new Error("目录必须使用绝对路径");
    error.code = "DIRECTORY_NOT_AUTHORIZED";
    throw error;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
  } catch (cause) {
    const error = new Error("目录不存在或应用无法访问");
    error.code = "DIRECTORY_NOT_BROWSABLE";
    throw error;
  }
  const authorizedRoots = realAuthorizedRoots(roots);
  if (!authorizedRoots.some((root) => isPathInside(root, resolved))) {
    const error = new Error("目标目录不在应用授权的共享目录内");
    error.code = "DIRECTORY_NOT_AUTHORIZED";
    throw error;
  }
  const capabilities = getDirectoryCapabilities(resolved);
  if (!capabilities.canBrowse) {
    const error = new Error("应用无法浏览此目录");
    error.code = "DIRECTORY_NOT_BROWSABLE";
    throw error;
  }
  const children = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const childPath = path.join(resolved, entry.name);
      let childCapabilities = {
        canBrowse: false,
        canSelect: false,
      };
      try {
        childCapabilities = getDirectoryCapabilities(childPath);
      } catch (error) {
        // Keep an inaccessible directory out of the tree.
      }
      return {
        name: entry.name,
        path: childPath,
        type: "directory",
        ...childCapabilities,
      };
    })
    .filter((entry) => entry.canBrowse || entry.canSelect)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));

  return {
    path: resolved,
    ...capabilities,
    children,
  };
}

function sanitizeOutputStem(outputStem) {
  const cleaned = String(outputStem || "archive")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
  return cleaned || "archive";
}

function createUniqueOutputDir(destinationRoot, outputStem) {
  ensureDirectoryAccess(destinationRoot);
  const safeStem = sanitizeOutputStem(outputStem);

  for (let index = 1; index < 10000; index += 1) {
    const name = index === 1 ? safeStem : `${safeStem} (${index})`;
    const candidate = path.join(destinationRoot, name);
    try {
      fs.mkdirSync(candidate, { mode: 0o750 });
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new Error(`无法创建解压目录：${error.message}`);
      }
    }
  }

  throw new Error("无法生成唯一的解压目录名称");
}

function defaultRootCandidates(
  archivePath,
  options = {},
) {
  return collectAuthorizedPathCandidates(archivePath, options);
}

function findArchiveAccessibleRoot(archivePath, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const realpathResolver = options.realpathResolver || fs.realpathSync;
  const capabilityResolver = options.capabilityResolver
    || getDirectoryCapabilities;
  const archiveDirectory = realpathResolver(pathApi.dirname(archivePath));
  if (platform === "win32") {
    return archiveDirectory;
  }

  const match = archiveDirectory.match(/^(\/vol\d+\/[^/]+\/[^/]+)(?:\/|$)/i);
  if (!match) {
    return archiveDirectory;
  }

  const boundary = match[1];
  let current = archiveDirectory;
  while (current !== boundary) {
    const parent = pathApi.dirname(current);
    if (
      parent === current
      || !(parent === boundary || parent.startsWith(`${boundary}/`))
    ) {
      break;
    }
    let capabilities;
    try {
      capabilities = capabilityResolver(parent);
    } catch (error) {
      break;
    }
    if (!capabilities.canBrowse) {
      break;
    }
    current = parent;
  }
  return current;
}

function discoverAuthorizedRoots(archivePath, options = {}) {
  const capabilityResolver = options.capabilityResolver
    || getDirectoryCapabilities;
  const candidates = [
    ...(options.candidateRoots || defaultRootCandidates(archivePath)),
  ];
  try {
    candidates.push(findArchiveAccessibleRoot(archivePath, {
      capabilityResolver,
      platform: options.platform,
      realpathResolver: options.realpathResolver,
    }));
  } catch (error) {
    // The archive directory candidate remains available as a safe fallback.
  }
  const accessible = [];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const capabilities = capabilityResolver(resolved);
      if (
        (capabilities.canBrowse || capabilities.canSelect)
        && !accessible.some((entry) => entry.path === resolved)
      ) {
        accessible.push({
          path: resolved,
          ...capabilities,
        });
      }
    } catch (error) {
      // Ignore paths that are absent or not granted to the application.
    }
  }

  accessible.sort((a, b) => a.path.length - b.path.length
    || a.path.localeCompare(b.path));
  const roots = [];
  for (const candidate of accessible) {
    if (!roots.some((root) => (
      root.canBrowse && isPathInside(root.path, candidate.path)
    ))) {
      roots.push(candidate);
    }
  }
  return roots.sort((a, b) => a.path.localeCompare(b.path, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

function directoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateDirectoryName(name) {
  const value = String(name || "").trim();
  if (
    !value
    || value === "."
    || value === ".."
    || value.length > 128
    || /[\/\\\x00-\x1f]/.test(value)
  ) {
    throw directoryError("INVALID_DIRECTORY_NAME", "文件夹名称无效");
  }
  return value;
}

function createAuthorizedDirectory(parentPath, name, roots) {
  let parent;
  try {
    parent = fs.realpathSync(parentPath);
  } catch (cause) {
    throw directoryError("DIRECTORY_NOT_BROWSABLE", "父目录不存在或无法访问");
  }
  const authorizedRoots = realAuthorizedRoots(roots);
  if (!authorizedRoots.some((root) => isPathInside(root, parent))) {
    throw directoryError(
      "DIRECTORY_NOT_AUTHORIZED",
      "目标目录不在应用授权的共享目录内",
    );
  }
  const capabilities = getDirectoryCapabilities(parent);
  if (!capabilities.canSelect) {
    throw directoryError("DIRECTORY_NOT_WRITABLE", "应用无法写入此目录");
  }
  const safeName = validateDirectoryName(name);
  const destination = path.join(parent, safeName);
  try {
    fs.mkdirSync(destination, { mode: 0o750 });
  } catch (cause) {
    if (cause.code === "EEXIST") {
      throw directoryError("DIRECTORY_EXISTS", "同名文件夹已经存在");
    }
    throw directoryError("DIRECTORY_NOT_WRITABLE", "无法创建文件夹");
  }
  const resolved = fs.realpathSync(destination);
  return {
    name: safeName,
    path: resolved,
    ...getDirectoryCapabilities(resolved),
  };
}

module.exports = {
  createAuthorizedDirectory,
  createUniqueOutputDir,
  defaultRootCandidates,
  discoverAuthorizedRoots,
  findArchiveAccessibleRoot,
  getDirectoryCapabilities,
  isPathInside,
  listAuthorizedDirectory,
  parseAccessiblePaths: parsePathList,
  resolveAuthorizedDirectory,
  sanitizeOutputStem,
  validateDirectoryName,
};
