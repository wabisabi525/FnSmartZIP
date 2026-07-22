"use strict";

const fs = require("node:fs");

function fingerprintFiles(filePaths) {
  return filePaths.map((filePath) => {
    const resolvedPath = fs.realpathSync(filePath);
    const stat = fs.statSync(resolvedPath);
    return {
      path: resolvedPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });
}

function verifyFingerprints(fingerprints) {
  for (const expected of fingerprints || []) {
    let actual;
    try {
      const resolvedPath = fs.realpathSync(expected.path);
      const stat = fs.statSync(resolvedPath);
      actual = {
        path: resolvedPath,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      const changed = new Error("源压缩包或分卷在任务启动后发生变化");
      changed.code = "SOURCE_CHANGED";
      throw changed;
    }
    if (
      actual.path !== expected.path
      || actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.size !== expected.size
      || actual.mtimeMs !== expected.mtimeMs
    ) {
      const error = new Error("源压缩包或分卷在任务启动后发生变化");
      error.code = "SOURCE_CHANGED";
      throw error;
    }
  }
}

module.exports = {
  fingerprintFiles,
  verifyFingerprints,
};
