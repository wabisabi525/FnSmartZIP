"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  findArchiveAccessibleRoot,
  createAuthorizedDirectory,
  createUniqueOutputDir,
  defaultRootCandidates,
  discoverAuthorizedRoots,
  getDirectoryCapabilities,
  isPathInside,
  listAuthorizedDirectory,
  parseAccessiblePaths,
  resolveAuthorizedDirectory,
} = require("../app/server/lib/paths");

const rootDir = path.resolve(__dirname, "..");

function makeFixture() {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-paths-"));
  const share = path.join(fixture, "share");
  const other = path.join(fixture, "share-other");
  fs.mkdirSync(path.join(share, "movies"), { recursive: true });
  fs.mkdirSync(path.join(share, "private"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  return { fixture, share, other };
}

test("path containment is segment-aware", () => {
  assert.equal(isPathInside("/vol1/share", "/vol1/share/movies"), true);
  assert.equal(isPathInside("/vol1/share", "/vol1/share"), true);
  assert.equal(isPathInside("/vol1/share", "/vol1/share-other"), false);
  assert.equal(isPathInside("/vol1/share", "/vol1/share/../private"), false);
});

test("parses fnOS authorized path environment formats", () => {
  assert.deepEqual(
    parseAccessiblePaths('["/vol1/share","/vol2/media"]'),
    ["/vol1/share", "/vol2/media"],
  );
  assert.deepEqual(
    parseAccessiblePaths("/vol1/share\n/vol2/media;/vol3/archive"),
    ["/vol1/share", "/vol2/media", "/vol3/archive"],
  );
  assert.deepEqual(parseAccessiblePaths("relative/path"), []);
});

test("prioritizes fnOS authorized roots before filesystem discovery", () => {
  const candidates = defaultRootCandidates("/vol2/media/a.7z", {
    environment: {
      TRIM_DATA_ACCESSIBLE_PATHS: '["/vol2/media","/vol1/share"]',
      TRIM_DATA_SHARE_PATHS: '["/vol3/app"]',
    },
    platform: "linux",
  });

  assert.deepEqual(candidates, [
    "/vol2/media",
    "/vol1/share",
    "/vol3/app",
  ]);
});

test("promotes the archive fallback to the highest browsable user folder", () => {
  const checked = [];
  const capabilities = new Map([
    ["/vol2/1000/其他/CN", { canBrowse: true, canSelect: true }],
    ["/vol2/1000/其他", { canBrowse: true, canSelect: true }],
  ]);

  const root = findArchiveAccessibleRoot(
    "/vol2/1000/其他/CN/作品/archive.7z.001",
    {
      platform: "linux",
      realpathResolver: (value) => value,
      capabilityResolver: (directoryPath) => {
        checked.push(directoryPath);
        return capabilities.get(directoryPath)
          || { canBrowse: false, canSelect: false };
      },
    },
  );

  assert.equal(root, "/vol2/1000/其他");
  assert.equal(checked.includes("/vol2/1000"), false);
});

test("stops archive fallback promotion at the first unreadable parent", () => {
  const root = findArchiveAccessibleRoot(
    "/vol2/1000/其他/CN/作品/archive.7z.001",
    {
      platform: "linux",
      realpathResolver: (value) => value,
      capabilityResolver: (directoryPath) => ({
        canBrowse: directoryPath !== "/vol2/1000/其他",
        canSelect: directoryPath !== "/vol2/1000/其他",
      }),
    },
  );

  assert.equal(root, "/vol2/1000/其他/CN");
});

test("resolves only directories inside authorized roots", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));

  const resolved = resolveAuthorizedDirectory(
    path.join(fixture.share, "movies"),
    [fixture.share],
  );
  assert.equal(resolved, fs.realpathSync(path.join(fixture.share, "movies")));

  assert.throws(
    () => resolveAuthorizedDirectory(fixture.other, [fixture.share]),
    /授权/,
  );
  assert.throws(
    () => resolveAuthorizedDirectory(
      path.join(fixture.share, "..", "share-other"),
      [fixture.share],
    ),
    /授权/,
  );
});

test("lists immediate authorized child directories", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));

  fs.writeFileSync(path.join(fixture.share, "file.txt"), "ignored");
  const result = listAuthorizedDirectory(fixture.share, [fixture.share]);

  assert.equal(result.path, fs.realpathSync(fixture.share));
  assert.deepEqual(
    result.children.map((entry) => entry.name),
    ["movies", "private"],
  );
  assert.ok(result.children.every((entry) => entry.canBrowse));
  assert.ok(result.children.every((entry) => entry.canSelect));
  assert.equal(result.canSelect, true);
});

test("reports directory browse and selection capabilities independently", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));

  assert.deepEqual(getDirectoryCapabilities(fixture.share), {
    canBrowse: true,
    canSelect: true,
  });
});

test("creates a validated directory inside an authorized root", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));

  const created = createAuthorizedDirectory(
    fixture.share,
    "新文件夹",
    [{ path: fixture.share, canBrowse: true, canSelect: true }],
  );
  assert.equal(created.path, path.join(fixture.share, "新文件夹"));
  assert.equal(created.canBrowse, true);
  assert.equal(created.canSelect, true);

  assert.throws(
    () => createAuthorizedDirectory(fixture.share, "../escape", [fixture.share]),
    (error) => error.code === "INVALID_DIRECTORY_NAME",
  );
  assert.throws(
    () => createAuthorizedDirectory(fixture.share, "新文件夹", [fixture.share]),
    (error) => error.code === "DIRECTORY_EXISTS",
  );
  assert.throws(
    () => createAuthorizedDirectory(fixture.other, "blocked", [fixture.share]),
    (error) => error.code === "DIRECTORY_NOT_AUTHORIZED",
  );
});

test("creates a new archive-named output directory without touching existing data", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));

  const existing = path.join(fixture.share, "movie");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep.txt"), "keep");

  const outputDir = createUniqueOutputDir(fixture.share, "movie");

  assert.equal(path.basename(outputDir), "movie (2)");
  assert.equal(fs.existsSync(path.join(existing, "keep.txt")), true);
  assert.equal(fs.statSync(outputDir).isDirectory(), true);
});

test("discovers writable authorized roots without nested duplicates", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));
  const archivePath = path.join(fixture.share, "movies", "movie.7z");
  fs.writeFileSync(archivePath, "archive");

  const roots = discoverAuthorizedRoots(archivePath, {
    candidateRoots: [
      fixture.share,
      path.join(fixture.share, "movies"),
      fixture.other,
      path.join(fixture.fixture, "missing"),
    ],
  });

  assert.deepEqual(roots, [
    {
      path: fs.realpathSync(fixture.share),
      canBrowse: true,
      canSelect: true,
    },
    {
      path: fs.realpathSync(fixture.other),
      canBrowse: true,
      canSelect: true,
    },
  ]);
});

test("keeps an explicit child root when its parent cannot be browsed", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.fixture, { recursive: true, force: true }));
  const child = path.join(fixture.share, "movies");

  const roots = discoverAuthorizedRoots(path.join(child, "movie.7z"), {
    candidateRoots: [fixture.share, child],
    capabilityResolver: (directoryPath) => (
      directoryPath === fs.realpathSync(fixture.share)
        ? { canBrowse: false, canSelect: true }
        : { canBrowse: true, canSelect: true }
    ),
  });

  assert.deepEqual(roots.map((root) => root.path), [
    fs.realpathSync(fixture.share),
    fs.realpathSync(child),
  ]);
});
