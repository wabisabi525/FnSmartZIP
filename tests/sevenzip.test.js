"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildExtractArgs,
  buildListArgs,
  buildTestArgs,
  normalizeCodePage,
} = require("../app/server/lib/sevenzip");
const { classifyArchive } = require("../app/server/lib/archive");

test("normalizes supported code page presets", () => {
  assert.deepEqual(normalizeCodePage("auto"), {
    id: "auto",
    codePage: null,
  });
  assert.equal(normalizeCodePage("utf8").codePage, 65001);
  assert.equal(normalizeCodePage("gbk").codePage, 936);
  assert.equal(normalizeCodePage("big5").codePage, 950);
  assert.equal(normalizeCodePage("shift_jis").codePage, 932);
  assert.equal(normalizeCodePage("korean").codePage, 949);
  assert.throws(() => normalizeCodePage("raw-switch"), /代码页/);
});

test("builds explicit split list and test arguments", () => {
  const selection = classifyArchive("/vol1/share/movie.7z.001");
  const listArgs = buildListArgs(selection, {
    archivePath: "/vol1/share/movie.7z.001",
    password: "",
    codePage: "gbk",
  });

  assert.deepEqual(listArgs, [
    "l",
    "-slt",
    "-sccUTF-8",
    "-t7z.split",
    "/vol1/share/movie.7z.001",
  ]);

  assert.deepEqual(buildTestArgs(selection, {
    archivePath: "/vol1/share/movie.7z.001",
    password: "secret",
    codePage: "auto",
  }), [
    "t",
    "-mmt=on",
    "-sccUTF-8",
    "-t7z.split",
    "-psecret",
    "/vol1/share/movie.7z.001",
  ]);
});

test("applies archive filename code pages only to ZIP", () => {
  const zipSelection = classifyArchive("/vol1/share/movie.zip.001");
  const zipArgs = buildListArgs(zipSelection, {
    archivePath: "/vol1/share/movie.zip.001",
    codePage: "gbk",
  });
  assert.ok(zipArgs.includes("-tzip.split"));
  assert.ok(zipArgs.includes("-mcp=936"));

  const rarSelection = classifyArchive("/vol1/share/movie.rar");
  const rarArgs = buildListArgs(rarSelection, {
    archivePath: "/vol1/share/movie.rar",
    codePage: "gbk",
  });
  assert.equal(rarArgs.some((arg) => arg.startsWith("-mcp=")), false);
});

test("builds selective extraction arguments without wildcard expansion", () => {
  const selection = classifyArchive("/vol1/share/movie.zip");
  const args = buildExtractArgs(selection, {
    archivePath: "/vol1/share/movie.zip",
    outputDir: "/vol2/media/movie",
    selectionFile: "/var/apps/FnSmartZIP/jobs/one/selection.txt",
    password: "",
    codePage: "utf8",
  });

  assert.deepEqual(args, [
    "x",
    "-y",
    "-aou",
    "-mmt=on",
    "-bsp1",
    "-bb1",
    "-sccUTF-8",
    "-tzip",
    "-mcp=65001",
    "-scsUTF-8",
    "-spd",
    "-i@/var/apps/FnSmartZIP/jobs/one/selection.txt",
    "-o/vol2/media/movie",
    "/vol1/share/movie.zip",
  ]);
});
