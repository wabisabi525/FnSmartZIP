"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const cgiFiles = ["app/ui/api.cgi", "app/ui/index.cgi"];
const lifecycleFiles = [
  "cmd/main",
  "cmd/config_callback",
  "cmd/install_callback",
  "cmd/upgrade_callback",
  "cmd/sync_authorized_paths",
];
const nodeSources = [
  "app/server/api.js",
  "app/www/js/main.js",
  "app/www/js/password-store.js",
  "scripts/audit-fpk.js",
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options,
  });
}

function formatFailure(result) {
  return [
    `exit: ${result.status}`,
    `stdout: ${result.stdout || ""}`,
    `stderr: ${result.stderr || ""}`,
  ].join("\n");
}

function checkShellSyntax(source) {
  if (process.platform === "win32") {
    const gitExecPath = run("git", ["--exec-path"]);
    if (gitExecPath.status === 0) {
      const shellPath = path.resolve(
        gitExecPath.stdout.trim(),
        "../../..",
        "usr/bin/sh.exe",
      );
      if (fs.existsSync(shellPath)) {
        return run(shellPath, ["-n"], { input: source });
      }
    }
  }

  return run("sh", ["-n"], { input: source });
}

function assertLfOnly(source, label) {
  assert.equal(
    source.includes(0x0d),
    false,
    `${label} contains a carriage return`,
  );
  assert.equal(source.at(-1), 0x0a, `${label} must end with LF`);
}

test("project has no runtime dependencies", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );

  assert.equal(packageJson.scripts.test, "node --test");
  assert.equal(packageJson.version, "1.0.0");
  assert.deepEqual(packageJson.dependencies || {}, {});
});

test("LF validation rejects bare carriage returns", () => {
  const source = Buffer.from("first line\rsecond line\n");

  assert.throws(
    () => assertLfOnly(source, "fixture"),
    /contains a carriage return/,
  );
});

for (const relativePath of cgiFiles) {
  test(`${relativePath} uses LF line endings`, () => {
    const source = fs.readFileSync(path.join(rootDir, relativePath));

    assertLfOnly(source, relativePath);
  });

  test(`${relativePath} passes sh -n`, () => {
    const source = fs.readFileSync(path.join(rootDir, relativePath));
    const result = checkShellSyntax(source);

    assert.ifError(result.error);
    assert.equal(result.status, 0, formatFailure(result));
  });
}

for (const relativePath of lifecycleFiles) {
  test(`${relativePath} uses LF line endings`, () => {
    const source = fs.readFileSync(path.join(rootDir, relativePath));
    assertLfOnly(source, relativePath);
  });

  test(`${relativePath} passes sh -n`, () => {
    const source = fs.readFileSync(path.join(rootDir, relativePath));
    const result = checkShellSyntax(source);

    assert.ifError(result.error);
    assert.equal(result.status, 0, formatFailure(result));
  });
}

for (const relativePath of nodeSources) {
  test(`${relativePath} passes Node syntax checking`, () => {
    const result = run(process.execPath, ["--check", relativePath]);

    assert.ifError(result.error);
    assert.equal(result.status, 0, formatFailure(result));
  });
}

test("UI CGI disables stale browser asset caching", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "app/ui/index.cgi"),
    "utf8",
  );
  assert.match(source, /Cache-Control: no-cache/);
});

test("UI CGI serves local WOFF2 fonts with the correct MIME type", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "app/ui/index.cgi"),
    "utf8",
  );
  assert.match(source, /woff2\)\s*\n\s*mime="font\/woff2"/);
});

test("Inter updater rejects cache paths outside the workspace", () => {
  if (process.platform !== "win32") {
    const source = fs.readFileSync(
      path.join(rootDir, "scripts/update-inter.ps1"),
      "utf8",
    );
    assert.match(source, /Refusing cache path outside workspace/);
    return;
  }

  const result = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/update-inter.ps1",
    ],
    {
      env: {
        ...process.env,
        FNSMARTZIP_CACHE_ROOT: "C:\\Temp\\FnSmartZIP-outside-workspace",
      },
    },
  );

  assert.ifError(result.error);
  assert.notEqual(result.status, 0, formatFailure(result));
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Refusing cache path outside workspace/,
  );
});

test("CGI files are executable in Git", () => {
  const result = run("git", ["ls-files", "--stage", "--", ...cgiFiles]);

  assert.ifError(result.error);
  assert.equal(result.status, 0, formatFailure(result));

  const entries = result.stdout.trim().split(/\r?\n/);
  assert.equal(entries.length, cgiFiles.length);
  for (const entry of entries) {
    assert.match(entry, /^100755 /);
  }
});

test("Git enforces LF checkouts for CGI files", () => {
  const result = run("git", ["check-attr", "eol", "--", ...cgiFiles]);

  assert.ifError(result.error);
  assert.equal(result.status, 0, formatFailure(result));

  const entries = result.stdout.trim().split(/\r?\n/);
  assert.equal(entries.length, cgiFiles.length);
  for (const entry of entries) {
    assert.match(entry, /: eol: lf$/);
  }
});
