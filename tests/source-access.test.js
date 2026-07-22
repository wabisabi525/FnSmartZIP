"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  classifySourceError,
  inspectSourceFile,
} = require("../app/server/lib/source-access");

const rootDir = path.resolve(__dirname, "..");

test("classifies source path failures without losing errno", () => {
  const missing = Object.assign(new Error("missing"), {
    code: "ENOENT",
    errno: -2,
    syscall: "stat",
  });
  const deniedFile = Object.assign(new Error("denied"), {
    code: "EACCES",
    errno: -13,
    syscall: "access",
  });
  const deniedParent = Object.assign(new Error("denied"), {
    code: "EPERM",
    errno: -1,
    syscall: "access",
  });

  assert.equal(
    classifySourceError(missing, "/vol2/a.7z", "file").code,
    "SOURCE_NOT_FOUND",
  );
  const fileError = classifySourceError(deniedFile, "/vol2/a.7z", "file");
  assert.equal(fileError.code, "SOURCE_FILE_DENIED");
  assert.equal(fileError.errno, -13);
  assert.equal(fileError.syscall, "access");
  assert.match(fileError.message, /a\.7z/);
  assert.match(fileError.message, /ACL/);
  assert.equal(
    classifySourceError(deniedParent, "/vol2/private", "parent").code,
    "SOURCE_PARENT_DENIED",
  );
});

test("reports file ownership, mode and application identity", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-source-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const filePath = path.join(fixture, "中文 archive.7z");
  fs.writeFileSync(filePath, "archive");

  const report = inspectSourceFile(filePath, {
    getuid: () => 964,
    getgid: () => 901,
    getgroups: () => [901, 976],
  });

  assert.equal(report.path, fs.realpathSync(filePath));
  assert.equal(report.readable, true);
  assert.equal(report.application.uid, 964);
  assert.equal(report.application.gid, 901);
  assert.deepEqual(report.application.groups, [901, 976]);
  assert.match(report.mode, /^0[0-7]{3}$/);
  assert.ok(report.components.length >= 2);
});

test("permission failures retain partial path and application diagnostics", () => {
  const fsModule = {
    statSync: (filePath) => {
      if (filePath === "/") {
        return {
          mode: 0o40755,
          uid: 0,
          gid: 0,
          isDirectory: () => true,
          isFile: () => false,
        };
      }
      if (filePath === "/vol2") {
        return {
          mode: 0o40000,
          uid: 0,
          gid: 0,
          isDirectory: () => true,
          isFile: () => false,
        };
      }
      throw Object.assign(new Error("unexpected"), { code: "ENOENT" });
    },
    accessSync: (filePath) => {
      if (filePath === "/vol2") {
        throw Object.assign(new Error("denied"), {
          code: "EACCES",
          errno: -13,
          syscall: "access",
        });
      }
    },
  };

  assert.throws(
    () => inspectSourceFile("/vol2/private/archive.7z", {
      fsModule,
      pathModule: path.posix,
      getuid: () => 964,
      getgid: () => 901,
      getgroups: () => [901, 976],
    }),
    (error) => (
      error.code === "SOURCE_PARENT_DENIED"
      && error.diagnostic.application.uid === 964
      && error.diagnostic.components.some(
        (component) => component.path === "/vol2"
          && component.accessible === false,
      )
    ),
  );
});
