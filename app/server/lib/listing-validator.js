#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const {
  createTechnicalListValidator,
} = require("./preview");
const {
  hasPasswordSwitch,
} = require("./sevenzip");

function writePasswordStdin(child, password) {
  if (!child?.stdin) {
    return;
  }
  if (password) {
    child.stdin.write(String(password));
    if (!String(password).endsWith("\n")) {
      child.stdin.write("\n");
    }
  }
  child.stdin.end();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function validateCommand(toolPath, cwd, args, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const child = spawnProcess(toolPath, args, {
    cwd: cwd || undefined,
    env: {
      ...process.env,
      LC_ALL: "C",
      LANG: "C",
      ...(dependencies.env || {}),
    },
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  writePasswordStdin(child, dependencies.password);
  const validator = createTechnicalListValidator({
    encoding: dependencies.encoding || process.env.FNSMARTZIP_LISTING_ENCODING || "utf-8",
  });
  let stderr = "";
  let validationError = null;
  let killTimer = null;
  child.stdout.on("data", (chunk) => {
    if (validationError) {
      return;
    }
    try {
      validator.write(chunk);
    } catch (error) {
      validationError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
      killTimer.unref?.();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65536);
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (validationError) {
        reject(validationError);
        return;
      }
      if (exitCode !== 0) {
        const error = new Error(stderr || `7-Zip exited with ${exitCode}`);
        error.exitCode = exitCode;
        error.log = stderr;
        reject(error);
        return;
      }
      try {
        resolve(validator.end());
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const [toolPath, cwd, ...args] = process.argv.slice(2);
  let password = "";
  if (hasPasswordSwitch(args)) {
    const raw = await readStdin();
    password = raw.toString("utf8").split(/\r?\n/, 1)[0] || "";
  }
  const result = await validateCommand(toolPath, cwd, args, {
    password,
    encoding: process.env.FNSMARTZIP_LISTING_ENCODING || "utf-8",
  });
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(error.log || error.message || "listing validation failed");
    process.exitCode = error.exitCode || 1;
  });
}

module.exports = {
  validateCommand,
};
