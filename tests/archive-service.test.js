"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  inspectArchive,
} = require("../app/server/lib/archive-service");

const rootDir = path.resolve(__dirname, "..");

function makeFixture() {
  return fs.mkdtempSync(path.join(rootDir, ".xinzip-archive-"));
}

test("normalizes a selected later split volume to the first volume", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, "movie.7z.001"), "one");
  fs.writeFileSync(path.join(fixture, "movie.7z.002"), "two");

  const info = inspectArchive(path.join(fixture, "movie.7z.002"), {
    sevenZip: { path: "/app/7zzs", source: "bundled" },
  });

  assert.equal(info.fileName, "movie.7z.001");
  assert.equal(info.selectedFileName, "movie.7z.002");
  assert.equal(info.selection.type, "7z.split");
  assert.equal(info.partCount, 2);
  assert.deepEqual(info.missingParts, []);
  assert.equal(info.outputStem, "movie");
});

test("reports missing split volumes without deleting or creating data", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, "movie.zip.001"), "one");
  fs.writeFileSync(path.join(fixture, "movie.zip.003"), "three");

  const info = inspectArchive(path.join(fixture, "movie.zip.001"), {
    sevenZip: { path: "/app/7zzs", source: "bundled" },
  });

  assert.deepEqual(info.missingParts, [2]);
  assert.match(info.warnings[0], /2/);
});

test("checks read access for every split volume before returning info", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const first = path.join(fixture, "movie.7z.001");
  const second = path.join(fixture, "movie.7z.002");
  fs.writeFileSync(first, "one");
  fs.writeFileSync(second, "two");

  assert.throws(
    () => inspectArchive(first, {
      sevenZip: { path: "/app/7zzs", source: "bundled" },
      inspectSource: (filePath) => {
        if (filePath.endsWith(".002")) {
          const error = new Error("第二个分卷没有读取 ACL");
          error.code = "SOURCE_FILE_DENIED";
          throw error;
        }
        return {
          path: fs.realpathSync(filePath),
          stat: fs.statSync(filePath),
        };
      },
    }),
    (error) => error.code === "SOURCE_FILE_DENIED"
      && /第二个分卷/.test(error.message),
  );
});

test("classifies archive directory listing permission failures", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const first = path.join(fixture, "movie.7z.001");
  fs.writeFileSync(first, "one");
  const fsModule = Object.create(fs);
  fsModule.readdirSync = () => {
    const error = new Error("permission denied");
    error.code = "EACCES";
    error.errno = -13;
    error.syscall = "scandir";
    throw error;
  };

  assert.throws(
    () => inspectArchive(first, {
      sevenZip: { path: "/app/7zzs", source: "bundled" },
      fsModule,
    }),
    (error) => error.code === "SOURCE_PARENT_DENIED"
      && error.errno === -13,
  );
});

test("rejects unsupported, missing and unreadable archive paths", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const textPath = path.join(fixture, "readme.txt");
  fs.writeFileSync(textPath, "text");

  assert.throws(() => inspectArchive(textPath), /不支持/);
  assert.throws(
    () => inspectArchive(path.join(fixture, "missing.7z")),
    /不存在|读取/,
  );
});
