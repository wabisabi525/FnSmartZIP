"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TERMINAL_STATUSES = new Set(["cancelled", "success", "failed"]);

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

class JobStore {
  constructor(runtimeRoot) {
    this.runtimeRoot = runtimeRoot;
    this.jobsDir = path.join(runtimeRoot, "jobs");
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  validateId(jobId) {
    if (!/^[a-f0-9]{32}$/.test(jobId || "")) {
      throw new Error("无效的任务 ID");
    }
  }

  jobPath(jobId) {
    this.validateId(jobId);
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  dataDir(jobId) {
    this.validateId(jobId);
    return path.join(this.jobsDir, `${jobId}.d`);
  }

  read(jobId) {
    const filePath = this.jobPath(jobId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  withLock(jobId, callback) {
    const lockPath = `${this.jobPath(jobId)}.lock`;
    let descriptor;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        sleepSync(5);
      }
    }
    if (descriptor == null) {
      throw new Error("任务状态文件正忙");
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }

  write(job) {
    const filePath = this.jobPath(job.id);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(job, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
    return job;
  }

  create(input) {
    const id = crypto.randomBytes(16).toString("hex");
    const job = {
      id,
      requestId: input.requestId || "",
      status: "queued",
      archivePath: input.archivePath,
      outputDir: input.outputDir,
      outputOwned: input.outputOwned !== false,
      selection: input.selection || null,
      sevenZipPath: input.sevenZipPath || "",
      sevenZipSource: input.sevenZipSource || "",
      codePage: input.codePage || "auto",
      selectionFile: input.selectionFile || "",
      passwordFile: input.passwordFile || "",
      partCount: input.partCount || 1,
      sourceFingerprint: input.sourceFingerprint || [],
      processGroupPid: null,
      workerPid: null,
      progress: 0,
      currentFile: "",
      log: "",
      error: null,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      createdAt: nowIso(),
    };
    fs.mkdirSync(this.dataDir(id), { recursive: true, mode: 0o700 });
    return this.withLock(id, () => this.write(job));
  }

  update(jobId, mutator) {
    return this.withLock(jobId, () => {
      const current = this.read(jobId);
      if (!current) {
        throw new Error("任务不存在或已过期");
      }
      const updated = mutator({ ...current });
      if (!updated || updated.id !== jobId) {
        throw new Error("任务更新结果无效");
      }
      return this.write(updated);
    });
  }

  cleanupExpired(options = {}) {
    const now = options.now || new Date();
    const maxAgeMs = options.maxAgeMs || 24 * 60 * 60 * 1000;
    const checkProcess = options.processExists || ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    });
    const removed = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const id = name.slice(0, -5);
      const job = this.read(id);
      if (!job) {
        continue;
      }
      const timestamp = job.finishedAt || job.startedAt || job.createdAt;
      if (
        !timestamp
        || now.getTime() - new Date(timestamp).getTime() <= maxAgeMs
      ) {
        continue;
      }
      if (
        !TERMINAL_STATUSES.has(job.status)
        && (
          (job.workerPid && checkProcess(job.workerPid))
          || (job.processGroupPid && checkProcess(-job.processGroupPid))
        )
      ) {
        continue;
      }
      if (!TERMINAL_STATUSES.has(job.status) && job.outputOwned && job.outputDir) {
        fs.rmSync(job.outputDir, { recursive: true, force: true });
      }
      fs.rmSync(this.jobPath(id), { force: true });
      fs.rmSync(this.dataDir(id), { recursive: true, force: true });
      removed.push(id);
    }
    for (const entry of fs.readdirSync(this.jobsDir, { withFileTypes: true })) {
      const entryPath = path.join(this.jobsDir, entry.name);
      const stat = fs.statSync(entryPath);
      if (now.getTime() - stat.mtimeMs <= maxAgeMs) {
        continue;
      }
      if (
        entry.isDirectory()
        && /^[a-f0-9]{32}\.d$/.test(entry.name)
        && !fs.existsSync(path.join(
          this.jobsDir,
          `${entry.name.slice(0, -2)}.json`,
        ))
      ) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else if (
        entry.isFile()
        && (
          /^[a-f0-9]{32}\.json\.lock$/.test(entry.name)
          || /^[a-f0-9]{32}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(entry.name)
        )
      ) {
        fs.rmSync(entryPath, { force: true });
      }
    }
    for (const entry of fs.readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory()
        || !/^(?:nested|validate)-/.test(entry.name)
      ) {
        continue;
      }
      const directoryPath = path.join(this.runtimeRoot, entry.name);
      const stat = fs.statSync(directoryPath);
      if (now.getTime() - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    }
    return removed;
  }
}

function processExists(pid, kill) {
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function requestCancellation(store, jobId, dependencies = {}) {
  const kill = dependencies.kill || process.kill.bind(process);
  const sleep = dependencies.sleep
    || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return job;
  }

  job = store.update(jobId, (current) => ({
    ...current,
    status: "cancelling",
    cancelRequestedAt: nowIso(),
  }));

  if (!job.processGroupPid) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(100);
      job = store.read(jobId) || job;
      if (TERMINAL_STATUSES.has(job.status) || job.processGroupPid) {
        break;
      }
    }
    if (!job.processGroupPid) {
      return job;
    }
  }

  try {
    kill(-job.processGroupPid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return job;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!processExists(job.processGroupPid, kill)) {
      return job;
    }
    await sleep(100);
  }

  try {
    kill(-job.processGroupPid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  return job;
}

module.exports = {
  JobStore,
  TERMINAL_STATUSES,
  nowIso,
  requestCancellation,
};
