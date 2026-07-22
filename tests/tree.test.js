"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTree,
  collectDescendantFiles,
  createSearchScheduler,
  filterTree,
  renderBatches,
  searchFiles,
  selectionState,
} = require("../app/www/js/tree");

const entries = [
  { path: "docs", type: "directory", size: 0 },
  { path: "docs/a.txt", type: "file", size: 1 },
  { path: "docs/guides", type: "directory", size: 0 },
  { path: "docs/guides/b.txt", type: "file", size: 2 },
  { path: "cover.jpg", type: "file", size: 3 },
];

test("builds a stable nested file tree", () => {
  const tree = buildTree(entries);
  assert.deepEqual(tree.map((node) => node.path), ["docs", "cover.jpg"]);
  assert.deepEqual(
    tree[0].children.map((node) => node.path),
    ["docs/guides", "docs/a.txt"],
  );
  assert.equal(tree[0].children[0].children[0].path, "docs/guides/b.txt");
});

test("collects directory leaf files for cascade selection", () => {
  const tree = buildTree(entries);
  assert.deepEqual(collectDescendantFiles(tree[0]), [
    "docs/guides/b.txt",
    "docs/a.txt",
  ]);
});

test("calculates checked, mixed and unchecked directory states", () => {
  const tree = buildTree(entries);
  assert.equal(
    selectionState(tree[0], new Set(["docs/a.txt", "docs/guides/b.txt"])),
    "checked",
  );
  assert.equal(
    selectionState(tree[0], new Set(["docs/a.txt"])),
    "mixed",
  );
  assert.equal(selectionState(tree[0], new Set()), "unchecked");
});

test("filters paths while preserving matching ancestors", () => {
  const tree = buildTree(entries);
  const filtered = filterTree(tree, "guides");

  assert.deepEqual(filtered.map((node) => node.path), ["docs"]);
  assert.deepEqual(filtered[0].children.map((node) => node.path), ["docs/guides"]);
  assert.equal(filtered[0].children[0].children[0].path, "docs/guides/b.txt");
});

test("searches file basenames without matching directories or parent paths", () => {
  const searchEntries = [
    { path: "archive/1.zip", type: "file", size: 1 },
    { path: "archive/2.zip", type: "file", size: 2 },
    { path: "archive/11.zip", type: "file", size: 11 },
    { path: "1/other.zip", type: "file", size: 3 },
    { path: "1", type: "directory", size: 0 },
  ];

  assert.deepEqual(
    searchFiles(searchEntries, " 1 ").map((entry) => entry.path),
    ["archive/1.zip", "archive/11.zip"],
  );
});

test("searches file basenames case-insensitively and preserves archive order", () => {
  const searchEntries = [
    { path: "docs/Report.TXT", type: "file", size: 1 },
    { path: "REPORT/other.txt", type: "file", size: 2 },
    { path: "其他/报告.txt", type: "file", size: 3 },
    { path: "REPORT", type: "directory", size: 0 },
    { path: "backup/report.txt", type: "file", size: 4 },
  ];

  assert.deepEqual(
    searchFiles(searchEntries, "report").map((entry) => entry.path),
    ["docs/Report.TXT", "backup/report.txt"],
  );
  assert.deepEqual(
    searchFiles(searchEntries, "报告").map((entry) => entry.path),
    ["其他/报告.txt"],
  );
  assert.deepEqual(searchFiles(searchEntries, ""), []);
});

test("searches ten thousand flat entries without rebuilding a tree", () => {
  const searchEntries = Array.from({ length: 10000 }, (_, index) => ({
    path: `folder-${index % 50}/file-${index}.zip`,
    type: "file",
    size: index,
  }));
  const startedAt = process.hrtime.bigint();
  const result = searchFiles(searchEntries, "file-999");
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.equal(result.length, 11);
  assert.equal(result[0].path, "folder-49/file-999.zip");
  assert.equal(result.at(-1).path, "folder-49/file-9999.zip");
  assert.ok(elapsedMs < 500, `flat search took ${elapsedMs.toFixed(1)}ms`);
});

test("debounced search runs only the latest scheduled callback", () => {
  const timers = [];
  const scheduler = createSearchScheduler({
    delay: 180,
    setTimer(callback, delay) {
      timers.push({ callback, delay, cleared: false });
      return timers.length - 1;
    },
    clearTimer(id) {
      timers[id].cleared = true;
    },
  });
  const calls = [];

  scheduler.schedule(() => calls.push("first"));
  scheduler.schedule(() => calls.push("second"));
  for (const timer of timers) {
    if (!timer.cleared) {
      timer.callback();
    }
  }

  assert.equal(timers[0].delay, 180);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(calls, ["second"]);
});

test("batched rendering stops when a newer search invalidates the request", () => {
  const frames = [];
  const rendered = [];
  let current = true;

  renderBatches([1, 2, 3, 4, 5], {
    batchSize: 2,
    scheduleFrame(callback) {
      frames.push(callback);
    },
    isCurrent() {
      return current;
    },
    renderBatch(items) {
      rendered.push(...items);
      current = false;
    },
  });

  while (frames.length) {
    frames.shift()();
  }

  assert.deepEqual(rendered, [1, 2]);
});
