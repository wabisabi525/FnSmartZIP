"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createDiagnosticLogger,
  DiagnosticLogger,
  redactDiagnosticValue,
  safeDiagnosticWrite,
} = require("../app/server/lib/diagnostics");

const rootDir = path.resolve(__dirname, "..");

test("redacts passwords and 7-Zip password arguments recursively", () => {
  const redacted = redactDiagnosticValue({
    password: "secret",
    passwordFile: "/tmp/password.txt",
    nested: {
      args: ["t", "-psecret", "archive.zip"],
      message: "safe",
    },
  });

  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.passwordFile, "[REDACTED]");
  assert.deepEqual(redacted.nested.args, ["t", "-p[REDACTED]", "archive.zip"]);
  assert.equal(redacted.nested.message, "safe");
  assert.equal(
    redactDiagnosticValue("spawn 7zz x -psecret archive.zip"),
    "spawn 7zz x -p[REDACTED] archive.zip",
  );
  assert.equal(
    redactDiagnosticValue('args:["-psecret"], command=-psecret'),
    'args:["-p[REDACTED]"], command=-p[REDACTED]',
  );
});

test("writes private rotating diagnostic logs without secrets", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-logs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const logger = new DiagnosticLogger({
    rootDir: fixture,
    maxBytes: 180,
    backups: 2,
  });

  for (let index = 0; index < 8; index += 1) {
    logger.write({
      event: "preview",
      index,
      password: "secret",
      args: ["l", "-psecret", "archive.zip"],
      detail: "x".repeat(50),
    });
  }

  const files = fs.readdirSync(fixture).sort();
  assert.ok(files.includes("fnsmartzip.log"));
  assert.ok(files.some((name) => /^fnsmartzip\.log\.\d+$/.test(name)));
  const content = files
    .map((name) => fs.readFileSync(path.join(fixture, name), "utf8"))
    .join("\n");
  assert.equal(content.includes("secret"), false);
  assert.match(content, /\[REDACTED\]/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(logger.logPath).mode & 0o777, 0o600);
  }
});

test("filters diagnostic log tails by request id", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-logs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const logger = new DiagnosticLogger({ rootDir: fixture });
  logger.write({ requestId: "one", message: "first" });
  logger.write({ requestId: "two", message: "private second" });
  logger.write({ requestId: "one", message: "third" });

  const tail = logger.tailForRequest("one");
  assert.match(tail, /first/);
  assert.match(tail, /third/);
  assert.doesNotMatch(tail, /private second/);
  assert.equal(logger.tailForRequest(""), "");
});

test("finds request logs after rotation", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-logs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const logger = new DiagnosticLogger({
    rootDir: fixture,
    maxBytes: 180,
    backups: 2,
  });
  logger.write({ requestId: "rotated", message: "first record" });
  logger.write({
    requestId: "other",
    message: "x".repeat(100),
  });

  const tail = logger.tailForRequest("rotated");
  assert.match(tail, /first record/);
  assert.doesNotMatch(tail, /other-/);
});

test("diagnostic logging failures never interrupt the caller", (t) => {
  assert.doesNotThrow(() => safeDiagnosticWrite({
    write: () => {
      throw new Error("disk full");
    },
  }, {
    event: "test",
  }));

  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-logs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const blockedRoot = path.join(fixture, "not-a-directory");
  fs.writeFileSync(blockedRoot, "file");
  const fallbackRoot = path.join(fixture, "fallback");
  const logger = createDiagnosticLogger({
    rootDirs: [blockedRoot, fallbackRoot],
  });
  logger.write({ event: "fallback" });
  assert.equal(
    fs.existsSync(path.join(fallbackRoot, "fnsmartzip.log")),
    true,
  );
});
