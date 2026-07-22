"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createServices,
} = require("../app/server/lib/services");
const { JobStore } = require("../app/server/lib/jobs");

const rootDir = path.resolve(__dirname, "..");
const listing = [
  "Path = archive.7z",
  "Type = 7z",
  "----------",
  "Path = folder",
  "Size = 0",
  "Attributes = D",
  "",
  "Path = folder/a.txt",
  "Size = 5",
  "Packed Size = 3",
  "Attributes = A",
  "",
].join("\n");

function setup(t, options = {}) {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-services-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const share = path.join(fixture, "share");
  const archiveDirectory = options.archiveSubdir
    ? path.join(share, options.archiveSubdir)
    : share;
  const runtimeRoot = path.join(fixture, "runtime");
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const archivePath = path.join(archiveDirectory, options.archiveName || "archive.7z");
  fs.writeFileSync(archivePath, "archive");
  const calls = [];
  const spawnSnapshots = [];
  const store = new JobStore(runtimeRoot);
  const services = createServices({
    runtimeRoot,
    store,
    findTool: () => ({ path: "/app/7zzs", source: "bundled" }),
    runSync: (tool, args) => {
      calls.push(args);
      if (options.runSync) {
        return options.runSync(tool, args);
      }
      if (options.previewError) {
        throw options.previewError;
      }
      const output = options.listing || listing;
      return { stdout: output, log: output, exitCode: 0 };
    },
    validateArchive: options.validateArchive,
    inspectSource: options.inspectSource,
    logger: options.logger,
    maxNestedPreviewBytes: options.maxNestedPreviewBytes,
    getDirectoryCapabilities: options.getDirectoryCapabilities,
    discoverRoots: options.discoverRoots || (() => [{
      path: share,
      canBrowse: true,
      canSelect: true,
    }]),
    spawnWorker: options.spawnWorker || ((jobId) => {
      spawnSnapshots.push(store.read(jobId));
      return { pid: 9876, jobId };
    }),
  });
  return {
    archivePath,
    calls,
    runtimeRoot,
    services,
    share,
    spawnSnapshots,
  };
}

test("provides info and preview through the archive engine", (t) => {
  const fixture = setup(t);

  const info = fixture.services.info({ path: fixture.archivePath });
  assert.equal(info.fileName, "archive.7z");
  assert.equal(info.tool.source, "bundled");

  const preview = fixture.services.preview({
    path: fixture.archivePath,
    codePage: "auto",
    password: "",
  });
  assert.equal(preview.entries.length, 2);
  assert.equal(preview.summary.fileCount, 1);
  assert.equal(fixture.calls[0][0], "l");
});

test("tests a supplied password before preview succeeds", (t) => {
  const passwordError = new Error("wrong password");
  passwordError.code = "PASSWORD";
  const fixture = setup(t, {
    runSync: (tool, args) => {
      if (args[0] === "t") {
        throw passwordError;
      }
      return { stdout: listing, log: listing, exitCode: 0 };
    },
  });

  assert.throws(
    () => fixture.services.preview({
      path: fixture.archivePath,
      codePage: "auto",
      password: "wrong",
    }),
    (error) => error.code === "PASSWORD",
  );
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l", "t"]);
});

test("returns an encrypted preview without testing an empty password", (t) => {
  const encryptedListing = listing.replace(
    "Attributes = A",
    ["Attributes = A", "Encrypted = +"].join("\n"),
  );
  const fixture = setup(t, {
    listing: encryptedListing,
  });

  const preview = fixture.services.preview({
    path: fixture.archivePath,
    codePage: "auto",
    password: "",
  });

  assert.equal(preview.passwordRequired, true);
  assert.equal(preview.passwordVerified, false);
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l"]);
});

test("verifies an encrypted preview when a password is supplied", (t) => {
  const encryptedListing = listing.replace(
    "Attributes = A",
    ["Attributes = A", "Encrypted = +"].join("\n"),
  );
  const fixture = setup(t, {
    listing: encryptedListing,
  });

  const preview = fixture.services.preview({
    path: fixture.archivePath,
    codePage: "auto",
    password: "secret",
  });

  assert.equal(preview.passwordRequired, true);
  assert.equal(preview.passwordVerified, true);
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l", "t"]);
});

test("probes generic split ZIP files before applying the selected code page", (t) => {
  const genericListing = [
    "Path = archive.001",
    "Type = Split",
    "Volumes = 1",
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
  const fixture = setup(t, {
    archiveName: "archive.001",
    listing: genericListing,
  });

  const preview = fixture.services.preview({
    path: fixture.archivePath,
    codePage: "gbk",
    password: "",
  });

  assert.equal(preview.format, "zip");
  assert.equal(fixture.calls.length, 2);
  assert.equal(
    fixture.calls[0].some((argument) => argument.startsWith("-mcp=")),
    false,
  );
  assert.ok(fixture.calls[1].includes("-mcp=936"));
});

test("prepares compressed tar wrappers before listing their contents", (t) => {
  const outerListing = [
    "Path = archive.tgz",
    "Type = gzip",
    "----------",
    "Path = archive.tar",
    "Size = 100",
    "Attributes = A",
    "",
  ].join("\n");
  const innerListing = listing.replace(
    ["Path = archive.7z", "Type = 7z"].join("\n"),
    ["Path = archive.tar", "Type = tar"].join("\n"),
  );
  const fixture = setup(t, {
    archiveName: "archive.tgz",
    runSync: (tool, args) => {
      if (args[0] === "x") {
        const outputDir = args.find((argument) => argument.startsWith("-o")).slice(2);
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, "archive.tar"), "tar");
        return { stdout: "", log: "", exitCode: 0 };
      }
      if (args.at(-1).endsWith(".tar")) {
        return { stdout: innerListing, log: innerListing, exitCode: 0 };
      }
      return { stdout: outerListing, log: outerListing, exitCode: 0 };
    },
  });

  const preview = fixture.services.preview({
    path: fixture.archivePath,
    codePage: "auto",
    password: "",
  });

  assert.equal(preview.format, "tar");
  assert.equal(preview.entries.some((entry) => entry.path === "folder/a.txt"), true);
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l", "x", "l"]);

  const extraction = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "",
  });
  const job = fixture.services.status({ jobId: extraction.jobId });
  assert.equal(job.selection.format, "gzip");
  assert.equal(job.selection.innerFormat, "tar");
});

test("creates a queued selective extraction job in a new output directory", (t) => {
  const fixture = setup(t);

  const result = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "secret",
    selectedPaths: ["folder/a.txt"],
    requestId: "request-one",
  });

  assert.match(result.jobId, /^[a-f0-9]{32}$/);
  assert.equal(path.basename(result.outputDir), "archive");
  assert.equal(fs.statSync(result.outputDir).isDirectory(), true);

  const job = fixture.services.status({ jobId: result.jobId });
  assert.equal(job.status, "queued");
  assert.equal(job.requestId, "request-one");
  assert.equal(job.workerPid, 9876);
  assert.equal(job.sourceFingerprint.length, 1);
  assert.equal(job.sourceFingerprint[0].path, fs.realpathSync(fixture.archivePath));
  assert.equal(fs.readFileSync(job.selectionFile, "utf8"), "folder/a.txt\n");
  assert.equal(fs.readFileSync(job.passwordFile, "utf8"), "secret");
  assert.equal(JSON.stringify(job).includes("secret"), false);
  assert.equal(String(job.log || "").includes("secret"), false);
  assert.equal(fixture.spawnSnapshots.length, 1);
  assert.equal(fixture.spawnSnapshots[0].selectionFile, job.selectionFile);
  assert.equal(fixture.spawnSnapshots[0].passwordFile, job.passwordFile);
});

test("lists authorized roots and directory children", (t) => {
  const fixture = setup(t);
  fs.mkdirSync(path.join(fixture.share, "movies"));

  const roots = fixture.services.directories({
    archivePath: fixture.archivePath,
  });
  assert.deepEqual(roots.roots, [{
    path: fixture.share,
    canBrowse: true,
    canSelect: true,
  }]);
  assert.equal(roots.defaultPath, fixture.share);

  const listingResult = fixture.services.directories({
    archivePath: fixture.archivePath,
    path: fixture.share,
  });
  assert.deepEqual(
    listingResult.children.map((entry) => entry.name),
    ["movies"],
  );
  assert.equal(listingResult.canSelect, true);
  assert.equal(listingResult.children[0].canBrowse, true);
  assert.equal(listingResult.children[0].canSelect, true);
});

test("creates a directory inside an authorized destination root", (t) => {
  const fixture = setup(t);

  const result = fixture.services.createDirectory({
    archivePath: fixture.archivePath,
    parentPath: fixture.share,
    name: "新文件夹",
  });

  assert.equal(result.path, path.join(fixture.share, "新文件夹"));
  assert.equal(fs.statSync(result.path).isDirectory(), true);
});

test("falls back when the archive directory itself is not writable", (t) => {
  let sharePath = "";
  let fallbackPath = "";
  const fixture = setup(t, {
    archiveSubdir: "readonly",
    discoverRoots: () => [
      { path: sharePath, canBrowse: true, canSelect: true },
      { path: fallbackPath, canBrowse: true, canSelect: true },
    ],
    getDirectoryCapabilities: (directoryPath) => ({
      canBrowse: true,
      canSelect: directoryPath !== path.join(sharePath, "readonly"),
    }),
  });
  sharePath = fixture.share;
  fallbackPath = path.join(fixture.runtimeRoot, "fallback");
  fs.mkdirSync(fallbackPath);

  const result = fixture.services.directories({
    archivePath: fixture.archivePath,
  });

  assert.equal(result.defaultPath, sharePath);
});

test("keeps permission diagnostics and request-scoped logs when source access fails", (t) => {
  let requestedLogId = "";
  const accessError = new Error("应用无法读取源文件");
  accessError.code = "SOURCE_FILE_DENIED";
  accessError.errno = -13;
  accessError.syscall = "access";
  accessError.path = "/vol2/private/archive.7z";
  accessError.diagnostic = {
    application: {
      uid: 964,
      gid: 901,
      groups: [901, 976],
    },
    components: [{
      path: "/vol2/private/archive.7z",
      type: "file",
      mode: "0700",
      uid: 1000,
      gid: 1001,
      accessible: false,
    }],
  };
  const fixture = setup(t, {
    inspectSource: () => {
      throw accessError;
    },
    logger: {
      write: () => {},
      tailForRequest: (requestId) => {
        requestedLogId = requestId;
        return "scoped log";
      },
    },
  });

  const report = fixture.services.diagnostics({
    path: fixture.archivePath,
    requestId: "0123456789abcdef",
  });

  assert.equal(report.source.readable, false);
  assert.equal(report.source.application.uid, 964);
  assert.equal(report.source.components[0].accessible, false);
  assert.deepEqual(report.authorizedRoots, [{
    path: fixture.share,
    canBrowse: true,
    canSelect: true,
  }]);
  assert.equal(report.logTail, "scoped log");
  assert.equal(requestedLogId, "0123456789abcdef");
});

test("queues whole archive extraction without synchronous preview", (t) => {
  const fixture = setup(t, {
    previewError: new Error("whole extraction must not preview"),
  });

  const result = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "",
  });

  assert.match(result.jobId, /^[a-f0-9]{32}$/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.spawnSnapshots.length, 1);
});

test("still requires preview validation for selective extraction", (t) => {
  const fixture = setup(t);

  const result = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "",
    selectedPaths: ["folder/a.txt"],
  });

  assert.match(result.jobId, /^[a-f0-9]{32}$/);
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l"]);
});

test("limits compressed tar expansion during preview", (t) => {
  const outerListing = [
    "Path = archive.tgz",
    "Type = gzip",
    "----------",
    "Path = archive.tar",
    "Size = 4096",
    "Attributes = A",
    "",
  ].join("\n");
  const fixture = setup(t, {
    archiveName: "archive.tgz",
    listing: outerListing,
    maxNestedPreviewBytes: 1024,
  });

  assert.throws(
    () => fixture.services.preview({
      path: fixture.archivePath,
      codePage: "auto",
      password: "",
    }),
    (error) => error.code === "PREVIEW_LIMIT",
  );
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["l"]);
});

test("cleans secrets and owned output when the worker fails to start", (t) => {
  const worker = new EventEmitter();
  worker.pid = 9876;
  const fixture = setup(t, {
    spawnWorker: () => worker,
  });

  const result = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "secret",
    selectedPaths: ["folder/a.txt"],
  });
  const before = fixture.services.status({ jobId: result.jobId });
  assert.equal(fs.existsSync(before.passwordFile), true);
  assert.equal(fs.existsSync(before.selectionFile), true);

  worker.emit("error", new Error("spawn failed"));

  const after = fixture.services.status({ jobId: result.jobId });
  assert.equal(after.status, "failed");
  assert.equal(after.error.code, "WORKER_START");
  assert.equal(fs.existsSync(result.outputDir), false);
  assert.equal(after.passwordFile, "");
  assert.equal(after.selectionFile, "");
});

test("cleans the task when a started worker exits unsuccessfully", (t) => {
  const worker = new EventEmitter();
  worker.pid = 9876;
  const fixture = setup(t, {
    spawnWorker: () => worker,
  });

  const result = fixture.services.extract({
    path: fixture.archivePath,
    destinationRoot: fixture.share,
    codePage: "auto",
    password: "secret",
  });
  worker.emit("exit", 1, null);

  const job = fixture.services.status({ jobId: result.jobId });
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "WORKER_EXIT");
  assert.equal(fs.existsSync(result.outputDir), false);
  assert.equal(job.passwordFile, "");
});
