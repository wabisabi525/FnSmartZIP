"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  validateSelectedPaths,
  writeSelectionFile,
} = require("../app/server/lib/selection");

const rootDir = path.resolve(__dirname, "..");
const entries = [
  { path: "folder", type: "directory" },
  { path: "folder/a.txt", type: "file" },
  { path: "folder/中文.txt", type: "file" },
];

test("validates and deduplicates selected leaf paths", () => {
  assert.deepEqual(
    validateSelectedPaths(
      ["folder/中文.txt", "folder/a.txt", "folder/a.txt"],
      entries,
    ),
    ["folder/中文.txt", "folder/a.txt"],
  );
});

test("rejects directories, unknown entries and unsafe names", () => {
  assert.throws(
    () => validateSelectedPaths(["folder"], entries),
    /文件/,
  );
  assert.throws(
    () => validateSelectedPaths(["missing.txt"], entries),
    /不存在/,
  );
  assert.throws(
    () => validateSelectedPaths(["../outside"], entries),
    /不安全|不存在/,
  );
});

test("writes a private UTF-8 selection list without a BOM", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-selection-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const filePath = writeSelectionFile(
    fixture,
    ["folder/中文.txt", "folder/a.txt"],
  );
  const content = fs.readFileSync(filePath);

  assert.equal(content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(content.toString("utf8"), "folder/中文.txt\nfolder/a.txt\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});
