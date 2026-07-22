#!/usr/bin/env node

"use strict";

const path = require("node:path");
const {
  writeAuthorizationSnapshot,
} = require("./lib/authorization-paths");

function main(environment = process.env) {
  if (!environment.TRIM_PKGVAR) {
    return null;
  }
  return writeAuthorizationSnapshot(
    path.join(environment.TRIM_PKGVAR, "authorized-paths.json"),
    environment,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`授权路径同步失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
};
