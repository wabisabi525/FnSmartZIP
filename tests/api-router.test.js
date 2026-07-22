"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  routeRequest,
} = require("../app/server/api");

function makeServices() {
  const calls = [];
  return {
    calls,
    info: (input) => {
      calls.push(["info", input]);
      return { fileName: "movie.7z" };
    },
    preview: (input) => {
      calls.push(["preview", input]);
      return { entries: [] };
    },
    directories: (input) => {
      calls.push(["directories", input]);
      return { children: [] };
    },
    createDirectory: (input) => {
      calls.push(["create-directory", input]);
      return { path: "/vol1/share/new" };
    },
    extract: (input) => {
      calls.push(["extract", input]);
      return { jobId: "abc" };
    },
    status: (input) => {
      calls.push(["status", input]);
      return { status: "running" };
    },
    cancel: (input) => {
      calls.push(["cancel", input]);
      return { status: "cancelling" };
    },
    diagnostics: (input) => {
      calls.push(["diagnostics", input]);
      return { requestId: "request-one" };
    },
  };
}

test("routes the eight public APIs", async () => {
  const services = makeServices();

  const infoResult = await routeRequest("info", {
    query: { path: "/a.7z" },
    body: {},
    requestId: "request-one",
  }, services);
  assert.equal(infoResult.data.fileName, "movie.7z");
  assert.equal(infoResult.requestId, "request-one");
  await routeRequest("preview", {
    query: {},
    body: { path: "/a.7z", codePage: "auto" },
  }, services);
  await routeRequest("directories", {
    query: { archivePath: "/a.7z", path: "/vol1/share" },
    body: {},
  }, services);
  await routeRequest("create-directory", {
    query: {},
    body: {
      archivePath: "/a.7z",
      parentPath: "/vol1/share",
      name: "新文件夹",
    },
  }, services);
  await routeRequest("extract", {
    query: {},
    body: { path: "/a.7z", destinationRoot: "/vol1/share" },
  }, services);
  await routeRequest("status", {
    query: { jobId: "one" },
    body: {},
  }, services);
  await routeRequest("cancel", {
    query: {},
    body: { jobId: "one" },
  }, services);
  await routeRequest("diagnostics", {
    query: { path: "/a.7z" },
    body: {},
    requestId: "request-one",
  }, services);

  assert.deepEqual(services.calls.map(([name]) => name), [
    "info",
    "preview",
    "directories",
    "create-directory",
    "extract",
    "status",
    "cancel",
    "diagnostics",
  ]);
});

test("rejects unknown APIs", async () => {
  await assert.rejects(
    routeRequest("unknown", { query: {}, body: {} }, makeServices()),
    /不存在/,
  );
});
