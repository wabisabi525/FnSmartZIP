#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const querystring = require("node:querystring");
const { createServices } = require("./lib/services");
const { runWorker } = require("./lib/worker");
const {
  safeDiagnosticWrite,
} = require("./lib/diagnostics");

const JSON_TYPE = "application/json; charset=utf-8";

function sendJson(body, statusCode = 200) {
  if (statusCode !== 200) {
    console.log(`Status: ${statusCode}`);
  }
  console.log(`Content-Type: ${JSON_TYPE}`);
  console.log("Cache-Control: no-store");
  console.log("");
  console.log(JSON.stringify(body));
}

function readRequestBody(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function parseJsonBody(rawBody) {
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error("请求 JSON 格式无效");
  }
}

function normalizeApiName(query, body) {
  return String(query.api || query._api || body.api || "").trim();
}

async function routeRequest(api, request, services) {
  const requestId = request.requestId || "";
  let data;
  if (api === "info") {
    data = await services.info({
      path: request.query.path,
      requestId,
    });
  } else if (api === "preview") {
    data = await services.preview({
      path: request.body.path,
      password: request.body.password || "",
      codePage: request.body.codePage || "auto",
      requestId,
    });
  } else if (api === "directories") {
    data = await services.directories({
      archivePath: request.query.archivePath,
      path: request.query.path || "",
      requestId,
    });
  } else if (api === "create-directory") {
    data = await services.createDirectory({
      archivePath: request.body.archivePath,
      parentPath: request.body.parentPath,
      name: request.body.name,
      requestId,
    });
  } else if (api === "extract") {
    data = await services.extract({
      path: request.body.path,
      password: request.body.password || "",
      codePage: request.body.codePage || "auto",
      destinationRoot: request.body.destinationRoot || "",
      selectedPaths: request.body.selectedPaths,
      requestId,
    });
  } else if (api === "status") {
    data = await services.status({
      jobId: request.query.jobId,
      requestId,
    });
  } else if (api === "cancel") {
    data = await services.cancel({
      jobId: request.body.jobId,
      requestId,
    });
  } else if (api === "diagnostics") {
    data = await services.diagnostics({
      path: request.query.path,
      requestId: request.query.requestId || requestId,
    });
  } else {
    const error = new Error("不存在的接口");
    error.code = "NOT_FOUND";
    throw error;
  }

  return {
    success: true,
    code: 200,
    data,
    requestId,
  };
}

async function main() {
  const services = createServices();
  const requestId = crypto.randomBytes(8).toString("hex");
  const startedAt = Date.now();
  let api = "";
  try {
    const query = querystring.parse(process.env.QUERY_STRING || "");
    const rawBody = await readRequestBody();
    const body = parseJsonBody(rawBody);
    api = normalizeApiName(query, body);
    services.store.cleanupExpired();
    const result = await routeRequest(api, {
      query,
      body,
      requestId,
    }, services);
    safeDiagnosticWrite(services.logger, {
      event: "api_request",
      requestId,
      api,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    sendJson(result);
  } catch (error) {
    safeDiagnosticWrite(services.logger, {
      event: "api_request",
      requestId,
      api,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        code: error.code || "INTERNAL",
        message: error.message,
        errno: error.errno ?? null,
        syscall: error.syscall || "",
        path: error.path || "",
        exitCode: error.exitCode ?? null,
        signal: error.signal || "",
        logTail: String(error.log || "").slice(-8192),
      },
    });
    error.requestId = requestId;
    throw error;
  }
}

async function runCli() {
  try {
    if (process.argv[2] === "--worker") {
      const jobId = process.argv[3];
      await runWorker(jobId, {
        runtimeRoot: process.env.FNSMARTZIP_RUNTIME_ROOT,
      });
      return;
    }
    await main();
  } catch (error) {
    sendJson({
      success: false,
      code: error.code === "NOT_FOUND" ? 404 : 500,
      error: {
        code: error.code || "INTERNAL",
        message: error.message || "调用错误",
      },
      msg: error.message || "调用错误",
      requestId: error.requestId || "",
    }, error.code === "NOT_FOUND" ? 404 : 200);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  main,
  normalizeApiName,
  parseJsonBody,
  readRequestBody,
  routeRequest,
  runCli,
  sendJson,
};
