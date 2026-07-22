#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_ITEMS = [
  "ICON.PNG",
  "ICON_256.PNG",
  "app",
  "cmd",
  "config",
  "manifest",
];
const PLATFORM_CONFIG = {
  x86: {
    vendorDir: "linux-x64",
    suffix: "x86_64",
  },
  arm: {
    vendorDir: "linux-arm64",
    suffix: "arm64",
  },
};
const BUILD_VARIANTS = ["search-fixed", "no-search"];

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside build root: ${candidate}`);
  }
}

function rewriteManifestPlatform(manifestPath, platform) {
  const original = fs.readFileSync(manifestPath, "utf8");
  const updated = /^platform\s*=.*$/m.test(original)
    ? original.replace(/^platform\s*=.*$/m, `platform              = ${platform}`)
    : `${original.trimEnd()}\nplatform              = ${platform}\n`;
  fs.writeFileSync(manifestPath, updated, "utf8");
}

function configureVariant(stageDir, variant) {
  if (!BUILD_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported variant: ${variant}`);
  }
  if (variant !== "no-search") {
    return;
  }

  const htmlPath = path.join(stageDir, "app", "www", "index.html");
  const original = fs.readFileSync(htmlPath, "utf8");
  const searchFieldPattern =
    /\n\s*<label class="search-field">[\s\S]*?<\/label>/;
  if (!searchFieldPattern.test(original)) {
    throw new Error("Search field marker is missing from index.html");
  }
  const updated = original
    .replace(
      '<div class="tree-toolbar">',
      '<div class="tree-toolbar is-search-disabled">',
    )
    .replace(searchFieldPattern, "");
  fs.writeFileSync(htmlPath, updated, "utf8");
}

function makeExecutables(stageDir, vendorDir) {
  for (const relativePath of [
    "app/ui/api.cgi",
    "app/ui/index.cgi",
    `app/vendor/7zip/${vendorDir}/7zzs`,
  ]) {
    fs.chmodSync(path.join(stageDir, relativePath), 0o755);
  }
  for (const name of fs.readdirSync(path.join(stageDir, "cmd"))) {
    fs.chmodSync(path.join(stageDir, "cmd", name), 0o755);
  }
}

function normalizeModes(stageDir, vendorDir) {
  const stack = [stageDir];
  while (stack.length) {
    const current = stack.pop();
    fs.chmodSync(current, 0o755);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        fs.chmodSync(entryPath, 0o644);
      }
    }
  }
  makeExecutables(stageDir, vendorDir);
}

function prepareStage({
  rootDir,
  buildRoot,
  platform,
  variant = "search-fixed",
}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!BUILD_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported variant: ${variant}`);
  }

  const stageDir = path.join(buildRoot, `FnSmartZIP-${variant}-${platform}`);
  assertInside(buildRoot, stageDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const item of PACKAGE_ITEMS) {
    fs.cpSync(path.join(rootDir, item), path.join(stageDir, item), {
      recursive: true,
      force: true,
    });
  }

  rewriteManifestPlatform(path.join(stageDir, "manifest"), platform);
  configureVariant(stageDir, variant);
  const vendorRoot = path.join(stageDir, "app", "vendor", "7zip");
  for (const directory of ["linux-x64", "linux-arm64"]) {
    if (directory !== config.vendorDir) {
      fs.rmSync(path.join(vendorRoot, directory), {
        recursive: true,
        force: true,
      });
    }
  }
  normalizeModes(stageDir, config.vendorDir);
  return stageDir;
}

function parseVersion(manifestPath) {
  const match = fs.readFileSync(manifestPath, "utf8")
    .match(/^version\s*=\s*(\S+)/m);
  if (!match) {
    throw new Error("Manifest version is missing");
  }
  return match[1];
}

function packageFileName(version, variant, platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!BUILD_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported variant: ${variant}`);
  }
  return `FnSmartZIP_${version}_${variant}_${config.suffix}.fpk`;
}

function buildPlatform({
  rootDir,
  buildRoot,
  distDir,
  platform,
  variant = "search-fixed",
  fnpackPath,
}) {
  const stageDir = prepareStage({
    rootDir,
    buildRoot,
    platform,
    variant,
  });
  fs.mkdirSync(distDir, { recursive: true });
  const result = spawnSync(fnpackPath, ["build", "--directory", stageDir], {
    cwd: distDir,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`fnpack failed for ${platform} with exit code ${result.status}`);
  }

  const generatedPath = path.join(distDir, "FnSmartZIP.fpk");
  if (!fs.existsSync(generatedPath)) {
    throw new Error(`fnpack did not create ${generatedPath}`);
  }
  const version = parseVersion(path.join(stageDir, "manifest"));
  const outputPath = path.join(
    distDir,
    packageFileName(version, variant, platform),
  );
  fs.rmSync(outputPath, { force: true });
  fs.renameSync(generatedPath, outputPath);
  return outputPath;
}

function parseArguments(argv) {
  const options = {
    platforms: ["x86", "arm"],
    variants: ["search-fixed"],
    stageOnly: false,
    fnpackPath: process.env.FNPACK_PATH || "fnpack",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--stage-only") {
      options.stageOnly = true;
    } else if (value === "--platform") {
      const platform = argv[index + 1];
      index += 1;
      options.platforms = platform === "all" ? ["x86", "arm"] : [platform];
    } else if (value === "--variant") {
      const variant = argv[index + 1];
      index += 1;
      options.variants = variant === "all"
        ? [...BUILD_VARIANTS]
        : [variant];
    } else if (value === "--fnpack") {
      options.fnpackPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function main() {
  const rootDir = path.resolve(__dirname, "..");
  const buildRoot = path.join(rootDir, "build", "staging");
  const distDir = path.join(rootDir, "dist");
  const options = parseArguments(process.argv.slice(2));
  for (const variant of options.variants) {
    for (const platform of options.platforms) {
      const stageDir = prepareStage({
        rootDir,
        buildRoot,
        platform,
        variant,
      });
      if (options.stageOnly) {
        console.log(stageDir);
        continue;
      }
      const outputPath = buildPlatform({
        rootDir,
        buildRoot,
        distDir,
        platform,
        variant,
        fnpackPath: options.fnpackPath,
      });
      console.log(outputPath);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BUILD_VARIANTS,
  PLATFORM_CONFIG,
  buildPlatform,
  configureVariant,
  normalizeModes,
  packageFileName,
  parseArguments,
  prepareStage,
};
