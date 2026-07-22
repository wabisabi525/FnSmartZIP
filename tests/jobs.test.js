"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  JobStore,
  requestCancellation,
} = require("../app/server/lib/jobs");

const rootDir = path.resolve(__dirname, "..");

test("creates and atomically updates job state", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);

  const created = store.create({
    archivePath: "/vol1/movie.7z",
    outputDir: "/vol2/movie",
    requestId: "request-one",
  });
  assert.match(created.id, /^[a-f0-9]{32}$/);
  assert.equal(created.status, "queued");
  assert.equal(created.requestId, "request-one");

  store.update(created.id, (job) => ({
    ...job,
    status: "running",
    processGroupPid: 1234,
  }));

  assert.equal(store.read(created.id).status, "running");
  assert.equal(
    fs.readdirSync(path.join(fixture, "jobs"))
      .some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("requests cancellation and signals the process group", async (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);
  const job = store.create({
    archivePath: "/vol1/movie.7z",
    outputDir: "/vol2/movie",
  });
  store.update(job.id, (current) => ({
    ...current,
    status: "running",
    processGroupPid: 4321,
  }));

  const signals = [];
  const result = await requestCancellation(store, job.id, {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    },
    sleep: async () => {},
  });

  assert.deepEqual(signals, [
    [-4321, "SIGTERM"],
    [-4321, 0],
  ]);
  assert.equal(result.status, "cancelling");
  assert.ok(result.cancelRequestedAt);
});

test("waits for a process group registered after cancellation", async (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);
  const job = store.create({
    archivePath: "/vol1/movie.7z",
    outputDir: "/vol2/movie",
  });
  const signals = [];
  let sleeps = 0;

  await requestCancellation(store, job.id, {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        store.update(job.id, (current) => ({
          ...current,
          processGroupPid: 9876,
        }));
      }
    },
  });

  assert.deepEqual(signals, [
    [-9876, "SIGTERM"],
    [-9876, 0],
  ]);
});

test("cleans expired terminal jobs but keeps active jobs", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);
  const old = store.create({ archivePath: "old", outputDir: "old" });
  const active = store.create({ archivePath: "active", outputDir: "active" });

  store.update(old.id, (job) => ({
    ...job,
    status: "success",
    finishedAt: "2026-07-18T00:00:00.000Z",
  }));
  store.update(active.id, (job) => ({
    ...job,
    status: "running",
    startedAt: "2026-07-20T06:00:00.000Z",
  }));

  const removed = store.cleanupExpired({
    now: new Date("2026-07-20T12:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
    processExists: () => false,
  });
  assert.deepEqual(removed, [old.id]);
  assert.equal(store.read(old.id), null);
  assert.equal(store.read(active.id).status, "running");
});

test("cleans stale active jobs, owned output, secrets and orphan temp directories", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);
  const outputDir = path.join(fixture, "owned-output");
  fs.mkdirSync(outputDir);
  const job = store.create({
    archivePath: "/vol1/movie.7z",
    outputDir,
    outputOwned: true,
  });
  const passwordFile = path.join(store.dataDir(job.id), "password.txt");
  fs.writeFileSync(passwordFile, "secret", { mode: 0o600 });
  store.update(job.id, (current) => ({
    ...current,
    status: "running",
    passwordFile,
    createdAt: "2026-07-18T00:00:00.000Z",
    startedAt: "2026-07-18T00:00:00.000Z",
  }));
  const orphan = path.join(fixture, "nested-orphan");
  fs.mkdirSync(orphan);
  fs.utimesSync(orphan, new Date("2026-07-18T00:00:00.000Z"), new Date("2026-07-18T00:00:00.000Z"));
  const orphanData = path.join(store.jobsDir, `${"a".repeat(32)}.d`);
  fs.mkdirSync(orphanData);
  const orphanLock = path.join(store.jobsDir, `${"b".repeat(32)}.json.lock`);
  const orphanTmp = path.join(store.jobsDir, `${"c".repeat(32)}.json.1.deadbeef.tmp`);
  fs.writeFileSync(orphanLock, "lock");
  fs.writeFileSync(orphanTmp, "tmp");
  for (const stalePath of [orphanData, orphanLock, orphanTmp]) {
    fs.utimesSync(
      stalePath,
      new Date("2026-07-18T00:00:00.000Z"),
      new Date("2026-07-18T00:00:00.000Z"),
    );
  }

  const removed = store.cleanupExpired({
    now: new Date("2026-07-21T12:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
    processExists: () => false,
  });

  assert.ok(removed.includes(job.id));
  assert.equal(fs.existsSync(outputDir), false);
  assert.equal(fs.existsSync(store.dataDir(job.id)), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(orphanData), false);
  assert.equal(fs.existsSync(orphanLock), false);
  assert.equal(fs.existsSync(orphanTmp), false);
});

test("keeps stale active jobs while their worker or process group exists", (t) => {
  const fixture = fs.mkdtempSync(path.join(rootDir, ".xinzip-jobs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const store = new JobStore(fixture);
  const job = store.create({
    archivePath: "/vol1/movie.7z",
    outputDir: path.join(fixture, "output"),
  });
  store.update(job.id, (current) => ({
    ...current,
    status: "running",
    workerPid: 1234,
    startedAt: "2026-07-18T00:00:00.000Z",
  }));

  const removed = store.cleanupExpired({
    now: new Date("2026-07-21T12:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
    processExists: (pid) => pid === 1234,
  });

  assert.deepEqual(removed, []);
  assert.equal(store.read(job.id).status, "running");
});
