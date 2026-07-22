"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SNAPSHOT_VERSION = 1;

function emptySnapshot() {
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: "",
    accessiblePaths: [],
    sharePaths: [],
  };
}

function parsePathList(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  let values;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      values = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      values = [];
    }
  } else {
    values = text.split(/[\r\n;:]+/);
  }
  return Array.from(new Set(
    values
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry && path.isAbsolute(entry)),
  ));
}

function normalizeSnapshot(value) {
  if (!value || value.version !== SNAPSHOT_VERSION) {
    return emptySnapshot();
  }
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    accessiblePaths: Array.isArray(value.accessiblePaths)
      ? parsePathList(JSON.stringify(value.accessiblePaths))
      : [],
    sharePaths: Array.isArray(value.sharePaths)
      ? parsePathList(JSON.stringify(value.sharePaths))
      : [],
  };
}

function readAuthorizationSnapshot(snapshotPath) {
  if (!snapshotPath) {
    return emptySnapshot();
  }
  try {
    return normalizeSnapshot(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
  } catch (error) {
    return emptySnapshot();
  }
}

function hasOwn(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function writeAuthorizationSnapshot(snapshotPath, environment, options = {}) {
  if (!snapshotPath) {
    throw new Error("授权路径快照位置无效");
  }
  const previous = readAuthorizationSnapshot(snapshotPath);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: (options.now || (() => new Date()))().toISOString(),
    accessiblePaths: hasOwn(environment, "TRIM_DATA_ACCESSIBLE_PATHS")
      ? parsePathList(environment.TRIM_DATA_ACCESSIBLE_PATHS)
      : previous.accessiblePaths,
    sharePaths: hasOwn(environment, "TRIM_DATA_SHARE_PATHS")
      ? parsePathList(environment.TRIM_DATA_SHARE_PATHS)
      : previous.sharePaths,
  };
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, snapshotPath);
    fs.chmodSync(snapshotPath, 0o600);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (error) {
      // The atomic rename already removed the temporary path.
    }
  }
  return snapshot;
}

function collectAuthorizedPathCandidates(archivePath, options = {}) {
  const environment = options.environment || process.env;
  const snapshotPath = options.snapshotPath
    || (environment.TRIM_PKGVAR
      ? path.join(environment.TRIM_PKGVAR, "authorized-paths.json")
      : "");
  const snapshot = readAuthorizationSnapshot(snapshotPath);
  const candidates = [
    ...parsePathList(environment.TRIM_DATA_ACCESSIBLE_PATHS),
    ...parsePathList(environment.TRIM_DATA_SHARE_PATHS),
    ...snapshot.accessiblePaths,
    ...snapshot.sharePaths,
    path.dirname(archivePath),
  ];
  return Array.from(new Set(candidates));
}

module.exports = {
  SNAPSHOT_VERSION,
  collectAuthorizedPathCandidates,
  emptySnapshot,
  parsePathList,
  readAuthorizationSnapshot,
  writeAuthorizationSnapshot,
};
