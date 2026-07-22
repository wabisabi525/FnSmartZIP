"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeEntryPath } = require("./preview");

function validateSelectedPaths(selectedPaths, entries) {
  if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) {
    throw new Error("请选择至少一个文件");
  }

  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const validated = [];

  for (const value of selectedPaths) {
    const normalized = normalizeEntryPath(value);
    const entry = entryMap.get(normalized);
    if (!entry) {
      throw new Error(`所选文件不存在于压缩包中：${normalized}`);
    }
    if (entry.type !== "file") {
      throw new Error(`选择性解压只能提交文件：${normalized}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      validated.push(normalized);
    }
  }

  return validated;
}

function writeSelectionFile(jobDir, selectedPaths) {
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(jobDir, "selection.txt");
  fs.writeFileSync(filePath, `${selectedPaths.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

module.exports = {
  validateSelectedPaths,
  writeSelectionFile,
};
