"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const test = require("node:test");

const { JobStore } = require("../app/server/lib/jobs");
const {
  defaultValidateListing,
  registerProcessGroup,
  runWorker,
} = require("../app/server/lib/worker");

const rootDir = path.resolve(__dirname, "..");

function setup(t, options = {}) {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-worker-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const outputDir = path.join(fixture, "output");
  fs.mkdirSync(outputDir);
  const store = new JobStore(fixture);
  const job = store.create({
    requestId: "request-one",
    archivePath: path.join(fixture, "movie.7z"),
    outputDir,
    outputOwned: true,
    selection: options.selection || {
      kind: "single",
      format: "7z",
      type: "7z",
    },
    sevenZipPath: "/app/7zzs",
    codePage: "auto",
  });
  return { fixture, job, outputDir, store };
}

test("runs preflight and extraction phases to success", async (t) => {
  const fixture = setup(t);
  const phases = [];
  const events = [];

  await runWorker(fixture.job.id, {
    store: fixture.store,
    logger: {
      write: (event) => events.push(event),
    },
    validateListing: () => ({ format: "7z" }),
    runPhase: async (phase, context) => {
      phases.push([phase, context.args[0]]);
      return { exitCode: 0, log: "100%" };
    },
  });

  const job = fixture.store.read(fixture.job.id);
  assert.deepEqual(phases, [
    ["testing", "t"],
    ["extracting", "x"],
  ]);
  assert.equal(job.status, "success");
  assert.equal(job.progress, 100);
  assert.ok(job.finishedAt);
  assert.deepEqual(events.map((event) => event.status), [
    "started",
    "success",
  ]);
  assert.ok(events.every((event) => event.requestId === "request-one"));
});

test("continues the worker lifecycle when diagnostic logging fails", async (t) => {
  const fixture = setup(t);

  await runWorker(fixture.job.id, {
    store: fixture.store,
    logger: {
      write: () => {
        throw Object.assign(new Error("log unavailable"), { code: "EACCES" });
      },
    },
    validateListing: () => ({ format: "7z" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });

  assert.equal(fixture.store.read(fixture.job.id).status, "success");
});

test("marks failures and removes only the owned output directory", async (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.outputDir, "partial.txt"), "partial");

  await runWorker(fixture.job.id, {
    store: fixture.store,
    validateListing: () => ({ format: "7z" }),
    runPhase: async (phase) => {
      if (phase === "testing") {
        return { exitCode: 0, log: "" };
      }
      const error = new Error("数据损坏");
      error.code = "DAMAGED";
      throw error;
    },
  });

  const job = fixture.store.read(fixture.job.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "DAMAGED");
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test("preserves cancellation state when a phase is interrupted", async (t) => {
  const fixture = setup(t);

  await runWorker(fixture.job.id, {
    store: fixture.store,
    validateListing: () => ({ format: "7z" }),
    runPhase: async () => {
      fixture.store.update(fixture.job.id, (job) => ({
        ...job,
        status: "cancelling",
        cancelRequestedAt: new Date().toISOString(),
      }));
      const error = new Error("terminated");
      error.code = "ENGINE";
      throw error;
    },
  });

  const job = fixture.store.read(fixture.job.id);
  assert.equal(job.status, "cancelled");
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test("does not overwrite cancellation requested during extraction", async (t) => {
  const fixture = setup(t);

  await runWorker(fixture.job.id, {
    store: fixture.store,
    validateListing: () => ({ format: "7z" }),
    runPhase: async (phase) => {
      if (phase === "extracting") {
        fixture.store.update(fixture.job.id, (job) => ({
          ...job,
          status: "cancelling",
          cancelRequestedAt: new Date().toISOString(),
        }));
      }
      return { exitCode: 0, log: "" };
    },
  });

  const job = fixture.store.read(fixture.job.id);
  assert.equal(job.status, "cancelled");
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test("extracts compressed tar wrappers through a private inner tar", async (t) => {
  const fixture = setup(t, {
    selection: {
      kind: "single",
      format: "gzip",
      type: null,
      innerFormat: "tar",
    },
  });
  const phases = [];

  await runWorker(fixture.job.id, {
    store: fixture.store,
    validateListing: () => ({ format: "tar" }),
    runPhase: async (phase, context) => {
      phases.push([phase, context.args.at(-1)]);
      if (phase === "preparing") {
        const outputDir = context.args
          .find((argument) => argument.startsWith("-o"))
          .slice(2);
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, "movie.tar"), "tar");
      }
      return { exitCode: 0, log: "" };
    },
  });

  assert.deepEqual(phases.map(([phase]) => phase), [
    "testing",
    "preparing",
    "testing",
    "extracting",
  ]);
  assert.equal(phases[2][1].endsWith("movie.tar"), true);
  assert.equal(phases[3][1].endsWith("movie.tar"), true);
  assert.equal(fixture.store.read(fixture.job.id).status, "success");
});

test("terminates a process registered after cancellation was requested", (t) => {
  const fixture = setup(t);
  fixture.store.update(fixture.job.id, (job) => ({
    ...job,
    status: "cancelling",
    cancelRequestedAt: new Date().toISOString(),
  }));
  const signals = [];

  registerProcessGroup(fixture.store, fixture.job.id, 4321, (pid, signal) => {
    signals.push([pid, signal]);
  });

  assert.deepEqual(signals, [[-4321, "SIGTERM"]]);
});

test("fails when the source archive changes after preflight", async (t) => {
  const fixture = setup(t);
  fs.writeFileSync(fixture.job.archivePath, "before");
  const stat = fs.statSync(fixture.job.archivePath);
  fixture.store.update(fixture.job.id, (job) => ({
    ...job,
    sourceFingerprint: [{
      path: fixture.job.archivePath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }],
  }));

  await runWorker(fixture.job.id, {
    store: fixture.store,
    validateListing: () => ({ format: "7z" }),
    runPhase: async (phase) => {
      if (phase === "testing") {
        fs.writeFileSync(fixture.job.archivePath, "after-change");
      }
      return { exitCode: 0, log: "" };
    },
  });

  const job = fixture.store.read(fixture.job.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "SOURCE_CHANGED");
});

test("registers the streaming listing helper as a cancellable process group", async (t) => {
  const fixture = setup(t);
  const child = new EventEmitter();
  child.pid = 2468;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const validation = defaultValidateListing(
    { path: "/app/7zzs" },
    ["l", "-slt", fixture.job.archivePath],
    {
      cwd: fixture.fixture,
      job: fixture.job,
      store: fixture.store,
      spawnProcess: () => child,
    },
  );
  assert.equal(fixture.store.read(fixture.job.id).processGroupPid, 2468);
  child.stdout.end(JSON.stringify({ entryCount: 1, format: "7z" }));
  child.emit("close", 0, null);

  assert.deepEqual(await validation, { entryCount: 1, format: "7z" });
  assert.equal(fixture.store.read(fixture.job.id).processGroupPid, null);
});
