"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifySevenZipError,
  parseProgress,
  runSevenZipSync,
  runSevenZipValidateSync,
} = require("../app/server/lib/engine");

test("classifies common 7-Zip failures", () => {
  assert.equal(classifySevenZipError("Wrong password", 2).code, "PASSWORD");
  assert.equal(classifySevenZipError("Missing volume : movie.002", 2).code, "MISSING_VOLUME");
  assert.equal(classifySevenZipError("Can not open file as archive", 2).code, "UNSUPPORTED");
  assert.equal(classifySevenZipError("Permission denied", 2).code, "PERMISSION");
  assert.equal(classifySevenZipError("Data Error", 2).code, "DAMAGED");
  assert.equal(classifySevenZipError("unknown", 9).code, "ENGINE");
});

test("classifies 7-Zip exit code 255 by execution context", () => {
  assert.equal(
    classifySevenZipError("Enter password:", 255, {
      passwordProvided: false,
    }).code,
    "PASSWORD_REQUIRED",
  );
  assert.equal(
    classifySevenZipError("Can not open encrypted archive. Wrong password?", 2, {
      passwordProvided: true,
    }).code,
    "PASSWORD",
  );
  assert.equal(
    classifySevenZipError("Break signaled", 255, {
      cancelled: true,
    }).code,
    "CANCELLED",
  );
  assert.equal(
    classifySevenZipError("Enter password:\nBreak signaled", 255, {
      cancelled: true,
      passwordProvided: false,
    }).code,
    "CANCELLED",
  );
  assert.equal(
    classifySevenZipError("Break signaled", 255, {
      phase: "preview",
    }).code,
    "PREVIEW_INTERRUPTED",
  );
  assert.equal(
    classifySevenZipError("Break signaled", 255).code,
    "ENGINE_INTERRUPTED",
  );
});

test("parses the latest progress percentage and current file", () => {
  const progress = parseProgress([
    " 12% 4 - folder/a.txt",
    " 48% 8 - folder/中文.txt",
  ].join("\n"));
  assert.deepEqual(progress, {
    percent: 48,
    currentFile: "folder/中文.txt",
  });
});

test("classifies output buffer overflow as a preview limit", () => {
  assert.throws(
    () => runSevenZipSync(
      { path: process.execPath },
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      { maxBuffer: 64 },
    ),
    (error) => error.code === "PREVIEW_LIMIT",
  );
});

test("infers supplied passwords from 7-Zip arguments", () => {
  assert.throws(
    () => runSevenZipSync(
      { path: process.execPath },
      [
        "-e",
        "process.stderr.write('Can not open encrypted archive. Wrong password?'); process.exit(2)",
        "--",
        "-psecret",
      ],
    ),
    (error) => error.code === "PASSWORD",
  );
});

test("validates unbounded listing output through the streaming helper", () => {
  const listing = [
    "Path = archive.001",
    "Type = Split",
    "Type = zip",
    "----------",
    "Path = folder/a.txt",
    "Size = 1",
    "Attributes = A",
    "",
  ].join("\n");
  const result = runSevenZipValidateSync(
    { path: process.execPath },
    ["-e", `process.stdout.write(${JSON.stringify(listing)})`],
  );
  assert.deepEqual(result, {
    entryCount: 1,
    format: "zip",
  });
});
