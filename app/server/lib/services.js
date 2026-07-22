"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inspectArchive } = require("./archive-service");
const {
  findSevenZip,
  runSevenZipSync,
  runSevenZipValidateSync,
} = require("./engine");
const {
  JobStore,
  requestCancellation,
  TERMINAL_STATUSES,
} = require("./jobs");
const {
  createAuthorizedDirectory,
  createUniqueOutputDir,
  discoverAuthorizedRoots,
  getDirectoryCapabilities,
  isPathInside,
  listAuthorizedDirectory,
  resolveAuthorizedDirectory,
} = require("./paths");
const {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
} = require("./nested");
const {
  detectTechnicalListFormat,
  parseTechnicalList,
} = require("./preview");
const {
  validateSelectedPaths,
  writeSelectionFile,
} = require("./selection");
const {
  buildExtractArgs,
  buildListArgs,
  buildTestArgs,
} = require("./sevenzip");
const {
  fingerprintFiles,
} = require("./source");
const {
  createDiagnosticLogger,
  redactDiagnosticValue,
} = require("./diagnostics");
const {
  inspectSourceFile,
} = require("./source-access");

function defaultRuntimeRoot() {
  const candidates = [
    process.env.TRIM_PKGTMP,
    process.env.TRIM_PKGVAR,
    path.join(os.tmpdir(), "FnSmartZIP"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch (error) {
      // Try the next runtime directory.
    }
  }
  throw new Error("无法创建 FnSmartZIP 运行目录");
}

function requireTool(findTool) {
  const tool = findTool();
  if (!tool) {
    throw new Error("未找到内置或系统 7-Zip 解压引擎");
  }
  return tool;
}

function createServices(options = {}) {
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot();
  const store = options.store || new JobStore(runtimeRoot);
  const findTool = options.findTool || findSevenZip;
  const runSync = options.runSync || runSevenZipSync;
  const validateListing = options.validateListing || runSevenZipValidateSync;
  const discoverRoots = options.discoverRoots || discoverAuthorizedRoots;
  const getCapabilities = options.getDirectoryCapabilities
    || getDirectoryCapabilities;
  const inspectSource = options.inspectSource || inspectSourceFile;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: options.logRoot
      ? [options.logRoot]
      : [
        process.env.TRIM_PKGVAR
          ? path.join(process.env.TRIM_PKGVAR, "logs")
          : "",
        path.join(runtimeRoot, "logs"),
      ].filter(Boolean),
  });
  const maxNestedPreviewBytes = options.maxNestedPreviewBytes
    || 8 * 1024 * 1024 * 1024;
  function withPreparedArchive(archive, input, callback) {
    if (!isNestedTar(archive.selection)) {
      return callback(archive);
    }

    const preparationDir = fs.mkdtempSync(
      path.join(runtimeRoot, "nested-"),
      { encoding: "utf8" },
    );
    try {
      const outerList = runSync(archive.tool, buildListArgs(archive.selection, {
        archivePath: archive.filePath,
        password: input.password || "",
        codePage: input.codePage || "auto",
      }), {
        cwd: archive.directory,
        maxBuffer: 64 * 1024 * 1024,
      });
      const outerPreview = parseTechnicalList(outerList.stdout);
      const nestedSize = outerPreview.summary.totalSize;
      let availableBytes = Number.POSITIVE_INFINITY;
      if (typeof fs.statfsSync === "function") {
        const statfs = fs.statfsSync(preparationDir);
        availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
      }
      if (
        nestedSize > maxNestedPreviewBytes
        || nestedSize > availableBytes * 0.8
      ) {
        const error = new Error("内部 TAR 归档过大，预览已降级为整包解压");
        error.code = "PREVIEW_LIMIT";
        throw error;
      }
      runSync(archive.tool, buildExtractArgs(archive.selection, {
        archivePath: archive.filePath,
        outputDir: preparationDir,
        selectionFile: "",
        password: input.password || "",
        codePage: input.codePage || "auto",
      }), {
        cwd: archive.directory,
      });
      const innerPath = findNestedTar(preparationDir);
      return callback({
        ...archive,
        filePath: innerPath,
        directory: path.dirname(innerPath),
        selection: innerTarSelection(),
      });
    } finally {
      fs.rmSync(preparationDir, { recursive: true, force: true });
    }
  }

  const validateArchive = options.validateArchive || ((archive, input) => {
    return withPreparedArchive(archive, input, (listingArchive) => {
      let effectiveSelection = listingArchive.selection;
      let args = buildListArgs(effectiveSelection, {
        archivePath: listingArchive.filePath,
        password: input.password || "",
        codePage: input.codePage || "auto",
      });
      let validation = validateListing(listingArchive.tool, args, {
        cwd: listingArchive.directory,
      });
      if (!effectiveSelection.format && validation.format) {
        effectiveSelection = {
          ...effectiveSelection,
          format: validation.format,
        };
        if ((input.codePage || "auto") !== "auto") {
          args = buildListArgs(effectiveSelection, {
            archivePath: listingArchive.filePath,
            password: input.password || "",
            codePage: input.codePage || "auto",
          });
          validation = validateListing(listingArchive.tool, args, {
            cwd: listingArchive.directory,
          });
        }
      }
      return {
        format: effectiveSelection.format,
        type: effectiveSelection.type,
        entryCount: validation.entryCount,
      };
    });
  });
  const spawnWorker = options.spawnWorker || ((jobId) => {
    const apiPath = path.resolve(__dirname, "..", "api.js");
    const child = spawn(process.execPath, [apiPath, "--worker", jobId], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        FNSMARTZIP_RUNTIME_ROOT: runtimeRoot,
      },
      windowsHide: true,
    });
    child.unref();
    return child;
  });

  function info(input) {
    const tool = requireTool(findTool);
    return inspectArchive(input.path, { sevenZip: tool });
  }

  function preview(input) {
    const archive = info(input);
    if (archive.missingParts.length) {
      const error = new Error(archive.warnings[0]);
      error.code = "MISSING_VOLUME";
      throw error;
    }
    const args = buildListArgs(archive.selection, {
      archivePath: archive.filePath,
      password: input.password || "",
      codePage: input.codePage || "auto",
    });
    return withPreparedArchive(archive, input, (listingArchive) => {
      let result = runSync(listingArchive.tool, buildListArgs(
        listingArchive.selection,
        {
          archivePath: listingArchive.filePath,
          password: input.password || "",
          codePage: input.codePage || "auto",
        },
      ), {
        cwd: listingArchive.directory,
        maxBuffer: 64 * 1024 * 1024,
        phase: "preview",
        passwordProvided: Boolean(input.password),
      });
      let effectiveSelection = listingArchive.selection;
      let detectedFormat = detectTechnicalListFormat(result.stdout);
      if (!effectiveSelection.format && detectedFormat) {
        effectiveSelection = {
          ...effectiveSelection,
          format: detectedFormat,
        };
        if ((input.codePage || "auto") !== "auto") {
          result = runSync(listingArchive.tool, buildListArgs(effectiveSelection, {
            archivePath: listingArchive.filePath,
            password: input.password || "",
            codePage: input.codePage || "auto",
          }), {
            cwd: listingArchive.directory,
            maxBuffer: 64 * 1024 * 1024,
            phase: "preview",
            passwordProvided: Boolean(input.password),
          });
          detectedFormat = detectTechnicalListFormat(result.stdout);
        }
      }
      const parsed = parseTechnicalList(result.stdout);
      const passwordRequired = Boolean(parsed.summary.encrypted);
      if (input.password) {
        runSync(listingArchive.tool, buildTestArgs(effectiveSelection, {
          archivePath: listingArchive.filePath,
          password: input.password || "",
          codePage: input.codePage || "auto",
        }), {
          cwd: listingArchive.directory,
          phase: "preview",
          passwordProvided: true,
        });
      }
      return {
        ...parsed,
        format: detectedFormat || effectiveSelection.format,
        type: effectiveSelection.type,
        parts: archive.parts,
        passwordRequired,
        passwordVerified: passwordRequired
          ? Boolean(input.password)
          : true,
      };
    });
  }

  function directories(input) {
    const archive = inspectArchive(input.archivePath, {
      sevenZip: requireTool(findTool),
    });
    const roots = discoverRoots(archive.filePath);
    if (!input.path) {
      const matchingRoot = roots
        .filter((root) => isPathInside(root.path || root, archive.directory))
        .sort((a, b) => (b.path || b).length - (a.path || a).length)[0];
      const fallbackRoot = roots.find((root) => root.canSelect ?? true);
      let archiveDirectorySelectable = false;
      try {
        archiveDirectorySelectable = getCapabilities(archive.directory).canSelect;
      } catch (error) {
        archiveDirectorySelectable = false;
      }
      return {
        roots,
        defaultPath: matchingRoot && archiveDirectorySelectable
          ? archive.directory
          : (fallbackRoot?.path || fallbackRoot || ""),
        path: "",
        children: [],
      };
    }
    return {
      roots,
      ...listAuthorizedDirectory(input.path, roots),
    };
  }

  function createDirectory(input) {
    const archive = inspectArchive(input.archivePath, {
      sevenZip: requireTool(findTool),
    });
    return createAuthorizedDirectory(
      input.parentPath,
      input.name,
      discoverRoots(archive.filePath),
    );
  }

  function extract(input) {
    const archive = info(input);
    if (archive.missingParts.length) {
      const error = new Error(archive.warnings[0]);
      error.code = "MISSING_VOLUME";
      throw error;
    }

    let previewResult = null;
    if (Array.isArray(input.selectedPaths)) {
      previewResult = preview(input);
    }

    const roots = discoverRoots(archive.filePath);
    const destinationRoot = resolveAuthorizedDirectory(
      input.destinationRoot || archive.directory,
      roots,
    );
    const outputDir = createUniqueOutputDir(destinationRoot, archive.outputStem);
    let job;

    try {
      const jobSelection = isNestedTar(archive.selection)
        ? archive.selection
        : {
          ...archive.selection,
          format: previewResult?.format
            || archive.selection.format,
          type: previewResult?.type
            ?? archive.selection.type,
        };
      job = store.create({
        requestId: input.requestId || "",
        archivePath: archive.filePath,
        outputDir,
        outputOwned: true,
        selection: jobSelection,
        sevenZipPath: archive.tool.path,
        sevenZipSource: archive.tool.source,
        codePage: input.codePage || "auto",
        partCount: archive.partCount,
        sourceFingerprint: fingerprintFiles(
          (archive.parts.length ? archive.parts : [{ path: archive.filePath }])
            .map((part) => part.path),
        ),
      });

      let selectionFile = "";
      if (Array.isArray(input.selectedPaths)) {
        const selectedPaths = validateSelectedPaths(
          input.selectedPaths,
          previewResult.entries,
        );
        selectionFile = writeSelectionFile(store.dataDir(job.id), selectedPaths);
      }

      let passwordFile = "";
      if (input.password) {
        passwordFile = path.join(store.dataDir(job.id), "password.txt");
        fs.writeFileSync(passwordFile, input.password, {
          encoding: "utf8",
          mode: 0o600,
        });
      }

      job = store.update(job.id, (current) => ({
        ...current,
        selectionFile,
        passwordFile,
      }));

      const worker = spawnWorker(job.id);
      job = store.update(job.id, (current) => ({
        ...current,
        workerPid: worker.pid || null,
      }));
      const failWorker = (workerError, code) => {
        const current = store.read(job.id);
        if (!current || TERMINAL_STATUSES.has(current.status)) {
          return;
        }
        for (const filePath of [current.passwordFile, current.selectionFile]) {
          if (filePath) {
            fs.rmSync(filePath, { force: true });
          }
        }
        if (current.outputOwned && current.outputDir) {
          fs.rmSync(current.outputDir, { recursive: true, force: true });
        }
        store.update(job.id, (latest) => ({
          ...latest,
          status: "failed",
          phase: "failed",
          passwordFile: "",
          selectionFile: "",
          workerPid: null,
          finishedAt: new Date().toISOString(),
          error: {
            code,
            message: workerError.message || "Worker 运行失败",
          },
        }));
      };
      if (typeof worker.once === "function") {
        worker.once("error", (workerError) => {
          failWorker(workerError, "WORKER_START");
        });
        worker.once("exit", (exitCode, signal) => {
          if (exitCode !== 0) {
            failWorker(
              new Error(
                `Worker 异常退出${signal ? `（${signal}）` : `（${exitCode}）`}`,
              ),
              "WORKER_EXIT",
            );
          }
        });
      }

      return {
        jobId: job.id,
        outputDir: job.outputDir,
        partCount: job.partCount,
      };
    } catch (error) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      if (job) {
        const current = store.read(job.id);
        for (const filePath of [current?.passwordFile, current?.selectionFile]) {
          if (filePath) {
            fs.rmSync(filePath, { force: true });
          }
        }
        store.update(job.id, (current) => ({
          ...current,
          status: "failed",
          passwordFile: "",
          selectionFile: "",
          error: {
            code: error.code || "START_FAILED",
            message: error.message,
          },
          finishedAt: new Date().toISOString(),
        }));
      }
      throw error;
    }
  }

  function status(input) {
    const job = store.read(input.jobId);
    if (!job) {
      throw new Error("任务不存在或已过期");
    }
    return job;
  }

  async function cancel(input) {
    return requestCancellation(store, input.jobId, options.cancellationDependencies);
  }

  function diagnostics(input) {
    let source = null;
    let sourceError = null;
    let roots = [];
    try {
      roots = discoverRoots(input.path);
    } catch (error) {
      roots = [];
    }
    try {
      source = inspectSource(input.path);
    } catch (error) {
      const diagnostic = error.diagnostic || {};
      const fileComponent = diagnostic.components
        ?.find((component) => component.type === "file");
      source = {
        path: error.path || input.path || "",
        readable: false,
        mode: fileComponent?.mode || "",
        uid: fileComponent?.uid ?? null,
        gid: fileComponent?.gid ?? null,
        size: null,
        modified: "",
        application: diagnostic.application || {
          uid: process.getuid?.() ?? null,
          gid: process.getgid?.() ?? null,
          groups: process.getgroups?.() || [],
        },
        components: diagnostic.components || [],
      };
      sourceError = {
        code: error.code || "SOURCE_DIAGNOSTIC_FAILED",
        message: error.message,
        errno: error.errno ?? null,
        syscall: error.syscall || "",
        path: error.path || input.path || "",
      };
    }
    let tool = null;
    try {
      tool = requireTool(findTool);
    } catch (error) {
      tool = {
        path: "",
        source: "missing",
        error: error.message,
      };
    }
    const diagnosticRequestId = /^[a-f0-9]{16}$/.test(input.requestId || "")
      ? input.requestId
      : "";
    let logTail = "";
    try {
      logTail = logger.tailForRequest(diagnosticRequestId);
    } catch (error) {
      logTail = "";
    }
    const report = {
      generatedAt: new Date().toISOString(),
      version: "1.0.0",
      requestId: diagnosticRequestId,
      source: {
        path: source.path,
        readable: source.readable,
        mode: source.mode,
        uid: source.uid,
        gid: source.gid,
        size: source.size,
        modified: source.modified,
        application: source.application,
        components: source.components,
      },
      sourceError,
      authorizedRoots: roots,
      engine: tool,
      runtimeRoot,
      logTail,
    };
    return redactDiagnosticValue(report);
  }

  return {
    cancel,
    createDirectory,
    directories,
    diagnostics,
    extract,
    info,
    preview,
    status,
    store,
    logger,
  };
}

module.exports = {
  createServices,
  defaultRuntimeRoot,
};
