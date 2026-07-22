"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  readAuthorizationSnapshot,
} = require("../app/server/lib/authorization-paths");

const rootDir = path.resolve(__dirname, "..");

test("authorization sync CLI writes fnOS environment paths to TRIM_PKGVAR", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-sync-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    "app/server/sync-authorized-paths.js",
  ], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      TRIM_PKGVAR: fixture,
      TRIM_DATA_ACCESSIBLE_PATHS: '["/vol1/media","/vol2/downloads"]',
      TRIM_DATA_SHARE_PATHS: "/vol3/app",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const snapshotPath = path.join(fixture, "authorized-paths.json");
  const snapshot = readAuthorizationSnapshot(snapshotPath);
  assert.deepEqual(snapshot.accessiblePaths, ["/vol1/media", "/vol2/downloads"]);
  assert.deepEqual(snapshot.sharePaths, ["/vol3/app"]);
});

test("lifecycle hooks invoke authorization sync without blocking callbacks", () => {
  for (const relativePath of [
    "cmd/main",
    "cmd/config_callback",
    "cmd/install_callback",
    "cmd/upgrade_callback",
  ]) {
    const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
    assert.match(source, /sync_authorized_paths/);
    assert.match(source, /\|\| true/);
  }
});
