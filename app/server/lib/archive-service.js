"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyArchive,
  collectVolumeNames,
} = require("./archive");
const {
  classifySourceError,
  inspectSourceFile,
} = require("./source-access");

function toClientFile(source, index) {
  return {
    index,
    path: source.path,
    name: path.basename(source.path),
    size: source.stat.size,
    modified: source.stat.mtime.toISOString(),
  };
}

function inspectArchive(selectedPath, options = {}) {
  if (!selectedPath || typeof selectedPath !== "string" || !path.isAbsolute(selectedPath)) {
    throw new Error("压缩包路径必须是绝对路径");
  }
  const fsModule = options.fsModule || fs;
  const inspectSource = options.inspectSource
    || ((filePath) => inspectSourceFile(filePath, { fsModule }));
  const selectedSource = inspectSource(selectedPath);
  const selectedRealPath = selectedSource.path;
  const selection = classifyArchive(selectedRealPath);
  if (!selection) {
    throw new Error("当前文件类型不支持");
  }

  const directory = path.dirname(selectedRealPath);
  const firstVolumePath = path.join(directory, selection.firstVolumeName);
  const firstSource = selectedRealPath === firstVolumePath
    ? selectedSource
    : inspectSource(firstVolumePath);
  const archivePath = firstSource.path;
  let directoryNames;
  try {
    directoryNames = fsModule.readdirSync(directory);
  } catch (error) {
    throw classifySourceError(error, directory, "parent");
  }
  const volumeInfo = collectVolumeNames(selection, directoryNames);
  const volumePaths = volumeInfo.names.map((name) => path.join(directory, name));
  const volumeSources = volumePaths.map((filePath) => (
    filePath === archivePath ? firstSource : inspectSource(filePath)
  ));
  const missingParts = volumeInfo.missingParts;
  const warnings = [];
  if (missingParts.length) {
    warnings.push(`检测到分卷缺失：${missingParts.join(", ")}`);
  }

  return {
    filePath: archivePath,
    fileName: path.basename(archivePath),
    selectedFilePath: selectedRealPath,
    selectedFileName: path.basename(selectedRealPath),
    directory,
    outputStem: selection.outputStem,
    selection,
    partCount: volumePaths.length,
    parts: volumeSources.map(toClientFile),
    missingParts,
    warnings,
    tool: options.sevenZip || null,
  };
}

module.exports = {
  inspectArchive,
};
