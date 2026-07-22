"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  collectAuthorizedPathCandidates,
  readAuthorizationSnapshot,
  writeAuthorizationSnapshot,
} = require("../app/server/lib/authorization-paths");

const rootDir = path.resolve(__dirname, "..");

function makeFixture(t) {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".fnsmartzip-auth-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  return {
    fixture,
    snapshotPath: path.join(fixture, "authorized-paths.json"),
  };
}

test("writes a private atomic authorization snapshot", (t) => {
  const fixture = makeFixture(t);

  const snapshot = writeAuthorizationSnapshot(fixture.snapshotPath, {
    TRIM_DATA_ACCESSIBLE_PATHS: '["/vol1/media","/vol2/downloads"]',
    TRIM_DATA_SHARE_PATHS: "/vol3/app-share",
  }, {
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });

  assert.deepEqual(snapshot, {
    version: 1,
    updatedAt: "2026-07-22T00:00:00.000Z",
    accessiblePaths: ["/vol1/media", "/vol2/downloads"],
    sharePaths: ["/vol3/app-share"],
  });
  assert.deepEqual(readAuthorizationSnapshot(fixture.snapshotPath), snapshot);
  assert.equal(fs.readFileSync(fixture.snapshotPath).subarray(0, 3)
    .equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(fixture.snapshotPath).mode & 0o777, 0o600);
  }
  assert.equal(
    fs.readdirSync(fixture.fixture).some((name) => name.includes(".tmp-")),
    false,
  );
});

test("preserves unset values and clears explicitly empty authorization values", (t) => {
  const fixture = makeFixture(t);
  writeAuthorizationSnapshot(fixture.snapshotPath, {
    TRIM_DATA_ACCESSIBLE_PATHS: "/vol1/media",
    TRIM_DATA_SHARE_PATHS: "/vol2/app",
  });

  writeAuthorizationSnapshot(fixture.snapshotPath, {
    TRIM_DATA_ACCESSIBLE_PATHS: "",
  });

  const snapshot = readAuthorizationSnapshot(fixture.snapshotPath);
  assert.deepEqual(snapshot.accessiblePaths, []);
  assert.deepEqual(snapshot.sharePaths, ["/vol2/app"]);
});

test("ignores corrupt and unsupported authorization snapshots", (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.snapshotPath, "{not-json", "utf8");
  assert.deepEqual(readAuthorizationSnapshot(fixture.snapshotPath), {
    version: 1,
    updatedAt: "",
    accessiblePaths: [],
    sharePaths: [],
  });

  fs.writeFileSync(fixture.snapshotPath, JSON.stringify({
    version: 2,
    accessiblePaths: ["/vol1/private"],
  }), "utf8");
  assert.deepEqual(readAuthorizationSnapshot(fixture.snapshotPath).accessiblePaths, []);
});

test("merges live paths, snapshot paths and the archive directory without scanning volumes", (t) => {
  const fixture = makeFixture(t);
  const archiveDir = path.join(fixture.fixture, "current");
  fs.mkdirSync(archiveDir);
  const archivePath = path.join(archiveDir, "archive.zip");
  fs.writeFileSync(archivePath, "zip");
  writeAuthorizationSnapshot(fixture.snapshotPath, {
    TRIM_DATA_ACCESSIBLE_PATHS: "/vol2/from-snapshot",
    TRIM_DATA_SHARE_PATHS: "/vol3/app-share",
  });

  const candidates = collectAuthorizedPathCandidates(archivePath, {
    environment: {
      TRIM_DATA_ACCESSIBLE_PATHS: "/vol1/live",
      TRIM_DATA_SHARE_PATHS: "/vol4/live-share",
    },
    snapshotPath: fixture.snapshotPath,
  });

  assert.deepEqual(candidates, [
    "/vol1/live",
    "/vol4/live-share",
    "/vol2/from-snapshot",
    "/vol3/app-share",
    archiveDir,
  ]);
});

test("loads the default snapshot from TRIM_PKGVAR", (t) => {
  const fixture = makeFixture(t);
  writeAuthorizationSnapshot(fixture.snapshotPath, {
    TRIM_DATA_ACCESSIBLE_PATHS: "/vol5/authorized",
  });
  const archiveDir = path.join(fixture.fixture, "current");
  fs.mkdirSync(archiveDir);

  const candidates = collectAuthorizedPathCandidates(
    path.join(archiveDir, "archive.zip"),
    {
      environment: {
        TRIM_PKGVAR: fixture.fixture,
      },
    },
  );

  assert.deepEqual(candidates, ["/vol5/authorized", archiveDir]);
});
