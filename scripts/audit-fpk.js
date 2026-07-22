#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const checksumPath = path.join(distDir, "SHA256SUMS.txt");
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
const FONT_SHA256 = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3";
const LICENSE_SHA256 = "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a";
const packages = [
  {
    fileName: "FnSmartZIP_1.0.0_search-fixed_x86_64.fpk",
    variant: "search-fixed",
    platform: "x86",
    sevenZipPath: "vendor/7zip/linux-x64/7zzs",
    unexpectedSevenZipPath: "vendor/7zip/linux-arm64/7zzs",
    machine: 62,
  },
  {
    fileName: "FnSmartZIP_1.0.0_search-fixed_arm64.fpk",
    variant: "search-fixed",
    platform: "arm",
    sevenZipPath: "vendor/7zip/linux-arm64/7zzs",
    unexpectedSevenZipPath: "vendor/7zip/linux-x64/7zzs",
    machine: 183,
  },
  {
    fileName: "FnSmartZIP_1.0.0_no-search_x86_64.fpk",
    variant: "no-search",
    platform: "x86",
    sevenZipPath: "vendor/7zip/linux-x64/7zzs",
    unexpectedSevenZipPath: "vendor/7zip/linux-arm64/7zzs",
    machine: 62,
  },
  {
    fileName: "FnSmartZIP_1.0.0_no-search_arm64.fpk",
    variant: "no-search",
    platform: "arm",
    sevenZipPath: "vendor/7zip/linux-arm64/7zzs",
    unexpectedSevenZipPath: "vendor/7zip/linux-x64/7zzs",
    machine: 183,
  },
];

function runTar(args, input) {
  const result = spawnSync(tarCommand, args, {
    cwd: rootDir,
    input,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${tarCommand} ${args.join(" ")} failed:\n${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

function outerEntry(packagePath, entryPath) {
  return runTar(["-xOf", packagePath, entryPath]);
}

function innerEntry(appArchive, entryPath) {
  return runTar(["-xOzf", "-", entryPath], appArchive);
}

function innerEntries(appArchive) {
  return new Set(
    runTar(["-tzf", "-"], appArchive)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readExpectedPackageHashes() {
  assert.equal(fs.existsSync(checksumPath), true, "missing SHA256SUMS.txt");
  const entries = new Map();
  for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) {
      entries.set(match[2], match[1].toLowerCase());
    }
  }
  return entries;
}

const expectedPackageHashes = readExpectedPackageHashes();

function auditPackage(config) {
  const packagePath = path.join(distDir, config.fileName);
  assert.equal(fs.existsSync(packagePath), true, `missing ${config.fileName}`);
  assert.equal(
    sha256(fs.readFileSync(packagePath)),
    expectedPackageHashes.get(config.fileName),
    `${config.fileName} does not match SHA256SUMS.txt`,
  );

  const manifest = outerEntry(packagePath, "manifest").toString("utf8");
  assert.match(manifest, /^version\s*=\s*1\.0\.0$/m);
  assert.match(
    manifest,
    new RegExp(`^platform\\s*=\\s*${config.platform}$`, "m"),
  );

  const appArchive = outerEntry(packagePath, "app.tgz");
  const entries = innerEntries(appArchive);
  assert.equal(entries.has(config.sevenZipPath), true);
  assert.equal(
    entries.has(config.unexpectedSevenZipPath),
    false,
    `${config.fileName} contains unexpected 7-Zip architecture`,
  );
  const font = innerEntry(appArchive, "www/fonts/InterVariable.woff2");
  const license = innerEntry(appArchive, "www/fonts/LICENSE-Inter.txt");
  const css = innerEntry(appArchive, "www/css/style.css").toString("utf8");
  const html = innerEntry(appArchive, "www/index.html").toString("utf8");
  const mainJs = innerEntry(appArchive, "www/js/main.js").toString("utf8");
  const sevenZip = innerEntry(appArchive, config.sevenZipPath);

  assert.equal(sha256(font), FONT_SHA256);
  assert.equal(sha256(license), LICENSE_SHA256);
  assert.match(license.toString("utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(css, /@font-face/);
  assert.match(css, /font-family:\s*"Inter Variable"/);
  assert.match(css, /InterVariable\.woff2\?v=4\.1/);
  if (config.variant === "search-fixed") {
    assert.match(html, /id="treeSearchInput"/);
    assert.match(mainJs, /createSearchScheduler\(\{\s*delay:\s*180/);
    assert.match(mainJs, /treeApi\.renderBatches/);
  } else {
    assert.doesNotMatch(html, /id="treeSearchInput"/);
    assert.match(html, /class="tree-toolbar is-search-disabled"/);
  }
  assert.equal(sevenZip.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(sevenZip.readUInt16LE(18), config.machine);

  console.log(`${config.fileName}: release audit passed`);
}

for (const config of packages) {
  auditPackage(config);
}
