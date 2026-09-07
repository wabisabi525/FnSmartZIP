"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  classifySevenZipError,
  parseProgress,
  spawnSevenZip,
  writePasswordStdin,
} = require("./engine");
const { JobStore } = require("./jobs");
const {
  buildExtractArgs,
  buildListArgs,
  hasPasswordSwitch,
} = require("./sevenzip");
const {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
} = require("./nested");
const {
  verifyFingerprints,
} = require("./source");
const {
  createDiagnosticLogger,
  safeDiagnosticWrite,
} = require("./diagnostics");
const {
  listingEncoding,
  recodeExtractedTree,
} = require("./code-page");

const JOB_LOG_LIMIT = 8 * 1024;

function mapPhaseProgress(phase, percent, range = {}) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const start = Math.max(0, Math.min(100, Number(range.start) || 0));
  const end = Math.max(start, Math.min(100, Number(range.end) || 100));
  return Math.round(start + (normalizedPercent * (end - start)) / 100);
}

function appendJobLog(store, jobId, chunk, phase, progressRange = {}) {
  const text = chunk.toString("utf8");
  store.update(jobId, (job) => {
    const log = `${job.log || ""}${text}`.slice(-JOB_LOG_LIMIT);
    const progress = parseProgress(log);
    return {
      ...job,
      phase,
      log,
      progress: Math.max(
        job.progress || 0,
        mapPhaseProgress(phase, progress.percent, progressRange),
      ),
      currentFile: progress.currentFile || job.currentFile,
    };
  });
}

function registerProcessGroup(
  store,
  jobId,
  processGroupPid,
  kill = process.kill.bind(process),
) {
  const job = store.update(jobId, (current) => ({
    ...current,
    status: current.status === "cancelling" ? "cancelling" : "running",
    processGroupPid,
    startedAt: current.startedAt || new Date().toISOString(),
  }));
  if (job.status === "cancelling" || job.cancelRequestedAt) {
    try {
      kill(-processGroupPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  return job;
}

function defaultRunPhase(phase, context) {
  return new Promise((resolve, reject) => {
    const child = spawnSevenZip(context.tool, context.args, {
      cwd: path.dirname(context.job.archivePath),
      detached: true,
      password: context.password,
      codePage: context.codePage,
    });

    registerProcessGroup(
      context.store,
      context.job.id,
      child.pid,
      context.kill,
    );
    context.store.update(context.job.id, (job) => ({
      ...job,
      phase,
    }));

    let log = "";
    const append = (chunk) => {
      log = `${log}${chunk.toString("utf8")}`.slice(-65536);
      appendJobLog(context.store, context.job.id, chunk, phase, {
        start: context.progressStart,
        end: context.progressEnd,
      });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const clearProcessGroup = () => {
      context.store.update(context.job.id, (job) => ({
        ...job,
        processGroupPid: null,
      }));
    };
    child.once("error", (error) => {
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearProcessGroup();
      if (exitCode === 0) {
        resolve({ exitCode, signal, log });
        return;
      }
      const current = context.store.read(context.job.id);
      const classified = classifySevenZipError(log, exitCode, {
        phase,
        passwordProvided: Boolean(context.passwordProvided || context.password),
        cancelled: current?.status === "cancelling"
          || Boolean(current?.cancelRequestedAt),
      });
      const error = new Error(classified.message);
      error.code = classified.code;
      error.exitCode = exitCode;
      error.signal = signal;
      error.log = log;
      reject(error);
    });
  });
}

function defaultValidateListing(tool, args, context) {
  return new Promise((resolve, reject) => {
    const spawnProcess = context.spawnProcess || spawn;
    const helperPath = path.join(__dirname, "listing-validator.js");
    const child = spawnProcess(process.execPath, [
      helperPath,
      tool.path,
      context.cwd || "",
      ...args,
    ], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LC_ALL: "C",
        LANG: "C",
        FNSMARTZIP_LISTING_ENCODING: context.encoding || "",
      },
      windowsHide: true,
    });
    writePasswordStdin(child, context.password);
    registerProcessGroup(
      context.store,
      context.job.id,
      child.pid,
      context.kill,
    );
    context.store.update(context.job.id, (job) => ({
      ...job,
      phase: "validating",
    }));

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65536);
    });
    const clearProcessGroup = () => {
      context.store.update(context.job.id, (job) => ({
        ...job,
        processGroupPid: null,
      }));
    };
    child.once("error", (error) => {
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearProcessGroup();
      if (exitCode !== 0) {
        const current = context.store.read(context.job.id);
        const classified = classifySevenZipError(stderr, exitCode, {
          phase: "validating",
          passwordProvided: Boolean(context.password) || hasPasswordSwitch(args),
          cancelled: current?.status === "cancelling"
            || Boolean(current?.cancelRequestedAt),
        });
        const error = new Error(classified.message);
        error.code = classified.code;
        error.exitCode = exitCode;
        error.signal = signal;
        error.log = stderr;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readAndRemoveSecret(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    const value = fs.readFileSync(filePath, "utf8");
    fs.rmSync(filePath, { force: true });
    return value;
  } catch (error) {
    return "";
  }
}

function cleanupOutput(job) {
  if (job.outputOwned && job.outputDir) {
    fs.rmSync(job.outputDir, { recursive: true, force: true });
  }
}

function cancellationError() {
  const error = new Error("任务已取消");
  error.code = "CANCELLED";
  return error;
}

function requireActiveJob(store, jobId) {
  const job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }
  if (job.status === "cancelling" || job.cancelRequestedAt) {
    throw cancellationError();
  }
  return job;
}

async function runWorker(jobId, options = {}) {
  const runtimeRoot = options.runtimeRoot
    || options.store?.runtimeRoot
    || process.env.FNSMARTZIP_RUNTIME_ROOT;
  const store = options.store || new JobStore(runtimeRoot);
  const runPhase = options.runPhase || defaultRunPhase;
  const validateListing = options.validateListing || defaultValidateListing;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: [
      process.env.TRIM_PKGVAR
        ? path.join(process.env.TRIM_PKGVAR, "logs")
        : "",
      path.join(runtimeRoot, "logs"),
    ].filter(Boolean),
  });
  let job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }

  const password = readAndRemoveSecret(job.passwordFile);
  const tool = {
    path: job.sevenZipPath,
    source: job.sevenZipSource,
  };
  const nestedDir = path.join(store.dataDir(jobId), "nested");

  safeDiagnosticWrite(logger, {
    event: "worker",
    status: "started",
    requestId: job.requestId || "",
    jobId,
    archivePath: job.archivePath,
  });

  try {
    verifyFingerprints(job.sourceFingerprint);
    requireActiveJob(store, jobId);
    job = store.update(jobId, (current) => ({
      ...current,
      status: current.status === "cancelling" ? "cancelling" : "running",
      phase: "validating",
      startedAt: current.startedAt || new Date().toISOString(),
      passwordFile: "",
    }));

    let extractionSelection = job.selection;
    let extractionArchivePath = job.archivePath;
    let extractionPassword = password;
    let extractionCodePage = job.codePage;
    if (isNestedTar(job.selection)) {
      requireActiveJob(store, jobId);
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o700 });
      const prepareArgs = buildExtractArgs(job.selection, {
        archivePath: job.archivePath,
        outputDir: nestedDir,
        selectionFile: "",
        password,
        codePage: job.codePage,
      });
      await runPhase("preparing", {
        args: prepareArgs,
        job,
        store,
        tool,
        password,
        passwordProvided: Boolean(password),
        codePage: job.codePage,
        progressStart: 0,
        progressEnd: 50,
      });
      verifyFingerprints(job.sourceFingerprint);
      requireActiveJob(store, jobId);
      extractionArchivePath = findNestedTar(nestedDir);
      extractionSelection = innerTarSelection();
      extractionPassword = "";
      extractionCodePage = "auto";
    }

    let listingArgs = buildListArgs(extractionSelection, {
      archivePath: extractionArchivePath,
      password: extractionPassword,
      codePage: extractionCodePage,
    });
    let listing = await validateListing(tool, listingArgs, {
      cwd: path.dirname(extractionArchivePath),
      job,
      store,
      password: extractionPassword,
      encoding: listingEncoding(extractionCodePage),
    });
    if (!extractionSelection.format && listing.format) {
      extractionSelection = {
        ...extractionSelection,
        format: listing.format,
      };
      if (extractionCodePage !== "auto") {
        listingArgs = buildListArgs(extractionSelection, {
          archivePath: extractionArchivePath,
          password: extractionPassword,
          codePage: extractionCodePage,
        });
        listing = await validateListing(tool, listingArgs, {
          cwd: path.dirname(extractionArchivePath),
          job,
          store,
          password: extractionPassword,
          encoding: listingEncoding(extractionCodePage),
        });
      }
    }
    verifyFingerprints(job.sourceFingerprint);
    requireActiveJob(store, jobId);

    const extractArgs = buildExtractArgs(extractionSelection, {
      archivePath: extractionArchivePath,
      outputDir: job.outputDir,
      selectionFile: job.selectionFile,
      password: extractionPassword,
      codePage: extractionCodePage,
    });
    await runPhase("extracting", {
      args: extractArgs,
      job,
      store,
      tool,
      password: extractionPassword,
      passwordProvided: Boolean(extractionPassword),
      codePage: extractionCodePage,
      progressStart: isNestedTar(job.selection) ? 50 : 0,
      progressEnd: 100,
    });
    recodeExtractedTree(job.outputDir, extractionCodePage);

    store.update(jobId, (current) => {
      if (current.status === "cancelling" || current.cancelRequestedAt) {
        throw cancellationError();
      }
      return {
        ...current,
        status: "success",
        phase: "complete",
        processGroupPid: null,
        progress: 100,
        currentFile: "",
        finishedAt: new Date().toISOString(),
        error: null,
      };
    });
    safeDiagnosticWrite(logger, {
      event: "worker",
      status: "success",
      requestId: job.requestId || "",
      jobId,
      outputDir: job.outputDir,
    });
  } catch (error) {
    job = store.read(jobId) || job;
    const cancelled = job.status === "cancelling"
      || Boolean(job.cancelRequestedAt)
      || error.code === "CANCELLED";
    cleanupOutput(job);
    store.update(jobId, (current) => ({
      ...current,
      status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed",
      processGroupPid: null,
      currentFile: "",
      finishedAt: new Date().toISOString(),
      error: cancelled
        ? null
        : {
          code: error.code || "ENGINE",
          message: error.message || "解压失败",
        },
    }));
    safeDiagnosticWrite(logger, {
      event: "worker",
      status: cancelled ? "cancelled" : "failed",
      requestId: job.requestId || "",
      jobId,
      error: {
        code: error.code || "ENGINE",
        message: error.message || "解压失败",
        errno: error.errno ?? null,
        syscall: error.syscall || "",
        exitCode: error.exitCode ?? null,
        signal: error.signal || "",
        logTail: String(error.log || "").slice(-8192),
      },
    });
  } finally {
    fs.rmSync(nestedDir, { recursive: true, force: true });
    const current = store.read(jobId);
    for (const filePath of [current?.passwordFile, current?.selectionFile]) {
      if (filePath) {
        fs.rmSync(filePath, { force: true });
      }
    }
    if (current) {
      store.update(jobId, (latest) => ({
        ...latest,
        passwordFile: "",
        selectionFile: "",
      }));
    }
  }

  return store.read(jobId);
}

module.exports = {
  appendJobLog,
  defaultRunPhase,
  defaultValidateListing,
  mapPhaseProgress,
  registerProcessGroup,
  runWorker,
};
