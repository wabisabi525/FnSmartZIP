"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTechnicalListValidator,
  detectTechnicalListFormat,
  PreviewLimitError,
  parseTechnicalList,
} = require("../app/server/lib/preview");

const sample = [
  "Path = /vol1/share/movie.7z.001",
  "Type = Split",
  "Volumes = 2",
  "----------",
  "Path = folder",
  "Size = 0",
  "Packed Size = 0",
  "Modified = 2026-07-20 10:00:00",
  "Attributes = D drwxr-xr-x",
  "Encrypted = -",
  "",
  "Path = folder/中文.txt",
  "Size = 12",
  "Packed Size = 9",
  "Modified = 2026-07-20 10:01:00",
  "Attributes = A -rw-r--r--",
  "Encrypted = +",
  "",
].join("\n");

test("parses 7-Zip technical list entries", () => {
  const result = parseTechnicalList(sample);

  assert.deepEqual(result.entries, [
    {
      path: "folder",
      name: "folder",
      parentPath: "",
      type: "directory",
      size: 0,
      packedSize: 0,
      modified: "2026-07-20 10:00:00",
      encrypted: false,
    },
    {
      path: "folder/中文.txt",
      name: "中文.txt",
      parentPath: "folder",
      type: "file",
      size: 12,
      packedSize: 9,
      modified: "2026-07-20 10:01:00",
      encrypted: true,
    },
  ]);
  assert.deepEqual(result.summary, {
    fileCount: 1,
    directoryCount: 1,
    totalSize: 12,
    encrypted: true,
  });
});

test("enforces entry and output limits", () => {
  assert.throws(
    () => parseTechnicalList(sample, { maxEntries: 1 }),
    PreviewLimitError,
  );
  assert.throws(
    () => parseTechnicalList(sample, { maxBytes: 8 }),
    PreviewLimitError,
  );
});

test("rejects malformed and unsafe archive entry paths", () => {
  const absolute = "----------\nPath = /etc/passwd\nSize = 1\nAttributes = A\n";
  assert.throws(() => parseTechnicalList(absolute), /不安全/);

  const traversal = "----------\nPath = ../outside.txt\nSize = 1\nAttributes = A\n";
  assert.throws(() => parseTechnicalList(traversal), /不安全/);

  const newline = "----------\nPath = bad\rname.txt\nSize = 1\nAttributes = A\n";
  assert.throws(() => parseTechnicalList(newline), /不安全|格式/);
});

test("detects the inner format of a generic split listing", () => {
  const genericSplit = [
    "Path = archive.001",
    "Type = Split",
    "Volumes = 2",
    "----",
    "Path = archive",
    "Type = zip",
    "Physical Size = 100",
    "",
    "----------",
    "Path = 中文.txt",
    "Size = 1",
    "Attributes = A",
    "",
  ].join("\n");

  assert.equal(detectTechnicalListFormat(genericSplit), "zip");
});

test("validates technical listings incrementally without retaining full output", () => {
  const validator = createTechnicalListValidator();
  validator.write("Path = archive.001\nType = Split\n");
  validator.write("Type = zip\n----------\nPath = folder/");
  validator.write("文件.txt\nSize = 1\nAttributes = A\n\n");
  assert.deepEqual(validator.end(), {
    entryCount: 1,
    format: "zip",
  });

  const unsafe = createTechnicalListValidator();
  assert.throws(
    () => unsafe.write("----------\nPath = ../outside.txt\n\n"),
    /不安全/,
  );
});

test("limits the number and total size of fields in one technical record", () => {
  const validator = createTechnicalListValidator({
    maxRecordLines: 3,
    maxRecordBytes: 32,
  });
  assert.throws(
    () => validator.write([
      "----------",
      "Path = a.txt",
      "Size = 1",
      "Packed Size = 1",
      "Attributes = A",
    ].join("\n")),
    /记录|格式/,
  );
});
