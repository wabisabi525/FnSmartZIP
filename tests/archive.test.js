"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyArchive,
  collectVolumeNames,
} = require("../app/server/lib/archive");

test("classifies regular archives", () => {
  assert.deepEqual(classifyArchive("/vol1/share/movie.7z"), {
    kind: "single",
    format: "7z",
    type: "7z",
    innerFormat: null,
    basename: "movie.7z",
    outputStem: "movie",
    partNumber: 1,
    firstVolumeName: "movie.7z",
  });

  assert.equal(classifyArchive("/vol1/share/movie.rar").format, "rar");
  assert.equal(classifyArchive("/vol1/share/movie.tar.gz").format, "gzip");
  assert.equal(classifyArchive("/vol1/share/movie.tar.gz").innerFormat, "tar");
  assert.equal(classifyArchive("/vol1/share/movie.tgz").innerFormat, "tar");
  assert.equal(classifyArchive("/vol1/share/movie.gz").innerFormat, null);
  assert.equal(classifyArchive("/vol1/share/movie.iso").format, "iso");
});

test("classifies 7z, zip, generic and RAR split archives", () => {
  const sevenZip = classifyArchive("/vol1/share/movie.7z.001");
  assert.equal(sevenZip.kind, "split");
  assert.equal(sevenZip.format, "7z");
  assert.equal(sevenZip.type, "7z.split");
  assert.equal(sevenZip.firstVolumeName, "movie.7z.001");
  assert.equal(sevenZip.outputStem, "movie");

  const zip = classifyArchive("/vol1/share/movie.zip.002");
  assert.equal(zip.kind, "split");
  assert.equal(zip.format, "zip");
  assert.equal(zip.type, "zip.split");
  assert.equal(zip.partNumber, 2);
  assert.equal(zip.firstVolumeName, "movie.zip.001");

  const generic = classifyArchive("/vol1/share/movie.001");
  assert.equal(generic.kind, "split");
  assert.equal(generic.format, null);
  assert.equal(generic.type, null);
  assert.equal(generic.firstVolumeName, "movie.001");

  const rar = classifyArchive("/vol1/share/movie.part02.rar");
  assert.equal(rar.kind, "rar-parts");
  assert.equal(rar.format, "rar");
  assert.equal(rar.partNumber, 2);
  assert.equal(rar.firstVolumeName, "movie.part01.rar");
  assert.equal(rar.outputStem, "movie");
});

test("rejects unsupported extensions", () => {
  assert.equal(classifyArchive("/vol1/share/readme.txt"), null);
  assert.equal(classifyArchive("/vol1/share/movie.exe"), null);
});

test("collects numeric split volumes and reports gaps", () => {
  const selection = classifyArchive("/vol1/share/movie.7z.001");
  const result = collectVolumeNames(selection, [
    "movie.7z.004",
    "notes.txt",
    "movie.7z.001",
    "movie.7z.002",
  ]);

  assert.deepEqual(result.names, [
    "movie.7z.001",
    "movie.7z.002",
    "movie.7z.004",
  ]);
  assert.deepEqual(result.missingParts, [3]);
});

test("collects zip z volumes and old RAR volumes", () => {
  const zip = classifyArchive("/vol1/share/movie.zip");
  const zipResult = collectVolumeNames(zip, [
    "movie.zip",
    "movie.z01",
    "movie.z03",
    "other.zip",
  ]);
  assert.deepEqual(zipResult.names, [
    "movie.z01",
    "movie.z03",
    "movie.zip",
  ]);
  assert.deepEqual(zipResult.missingParts, [2]);
  assert.equal(zipResult.firstVolumeName, "movie.zip");

  const rar = classifyArchive("/vol1/share/movie.rar");
  const rarResult = collectVolumeNames(rar, [
    "movie.rar",
    "movie.r00",
    "movie.r01",
  ]);
  assert.deepEqual(rarResult.names, [
    "movie.rar",
    "movie.r00",
    "movie.r01",
  ]);
  assert.deepEqual(rarResult.missingParts, []);
});
