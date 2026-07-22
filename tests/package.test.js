"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  packageFileName,
  parseArguments,
  prepareStage,
} = require("../scripts/build-fpk");

const rootDir = path.resolve(__dirname, "..");

function sha256(filePath) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function parseManifest(text) {
  return Object.fromEntries(
    text.split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+)\s*=\s*(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()]),
  );
}

test("manifest declares FnSmartZIP 1.0.0 for Node.js 22", () => {
  const manifest = parseManifest(
    fs.readFileSync(path.join(rootDir, "manifest"), "utf8"),
  );
  assert.equal(manifest.appname, "FnSmartZIP");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.display_name, "FnSmartZIP");
  assert.equal(manifest.platform, "x86");
  assert.equal(manifest.install_dep_apps, "nodejs_v22");
  assert.equal(manifest.desktop_applaunchname, "FnSmartZIP.Application");
  assert.equal(manifest.maintainer, "wabisabi525");
  assert.equal(manifest.maintainer_url, "https://github.com/wabisabi525");
  assert.equal(manifest.distributor, "wabisabi525");
  assert.equal(manifest.distributor_url, "https://github.com/wabisabi525");
  assert.equal(manifest.arch, undefined);
});

test("provides every desktop icon size referenced by the UI template", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(rootDir, "app/ui/config"), "utf8"),
  );
  assert.equal(
    config[".url"]["FnSmartZIP.Application"].icon,
    "images/icon_{0}.png",
  );

  for (const size of [16, 24, 32, 48, 64, 72, 128, 256]) {
    const content = fs.readFileSync(
      path.join(rootDir, `app/ui/images/icon_${size}.png`),
    );
    assert.equal(content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(content.readUInt32BE(16), size, `icon_${size}.png width`);
    assert.equal(content.readUInt32BE(20), size, `icon_${size}.png height`);
  }

  for (const name of ["ICON.PNG", "ICON_256.PNG"]) {
    const content = fs.readFileSync(path.join(rootDir, name));
    assert.equal(content.readUInt32BE(16), 256);
    assert.equal(content.readUInt32BE(20), 256);
  }

  const webIcon = fs.readFileSync(
    path.join(rootDir, "app/www/images/icon_64.png"),
  );
  assert.equal(webIcon.readUInt32BE(16), 64);
  assert.equal(webIcon.readUInt32BE(20), 64);
});

test("right-click integration includes common archive formats", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(rootDir, "app/ui/config"), "utf8"),
  );
  const application = config[".url"]["FnSmartZIP.Application"];
  assert.equal(application.title, "使用 FnSmartZIP 打开");
  assert.equal(
    application.url,
    "/cgi/ThirdParty/FnSmartZIP/index.cgi",
  );
  assert.equal(application.allUsers, false);
  const fileTypes = application.fileTypes;
  for (const extension of [
    "001", "7z", "zip", "rar", "tar", "tgz", "gz", "bz2",
    "xz", "zst", "tzst", "cab", "iso", "arj", "lzh", "lha",
  ]) {
    assert.ok(fileTypes.includes(extension), `missing ${extension}`);
  }
});

test("package resource config does not hard-code a user volume", () => {
  const text = fs.readFileSync(path.join(rootDir, "config/resource"), "utf8");
  assert.equal(text.includes("/vol1/1000"), false);
  assert.deepEqual(JSON.parse(text), {});
});

test("bundles 7-Zip 26.02 ELF binaries for x86_64 and ARM64", () => {
  const binaries = [
    ["linux-x64/7zzs", 62],
    ["linux-arm64/7zzs", 183],
  ];
  for (const [relativePath, machine] of binaries) {
    const content = fs.readFileSync(
      path.join(rootDir, "app/vendor/7zip", relativePath),
    );
    assert.equal(content.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(content.readUInt16LE(18), machine);
    assert.ok(content.includes(Buffer.from("26.02")));
  }
});

test("bundles the pinned Inter 4.1 variable font and license", () => {
  const fontPath = path.join(
    rootDir,
    "app/www/fonts/InterVariable.woff2",
  );
  const licensePath = path.join(
    rootDir,
    "app/www/fonts/LICENSE-Inter.txt",
  );

  assert.equal(fs.statSync(fontPath).size, 352240);
  assert.equal(
    sha256(fontPath),
    "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3",
  );
  assert.equal(
    sha256(licensePath),
    "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a",
  );
  assert.match(
    fs.readFileSync(licensePath, "utf8"),
    /SIL OPEN FONT LICENSE Version 1\.1/,
  );
});

test("Inter updater is pinned and keeps downloads in the workspace cache", () => {
  const script = fs.readFileSync(
    path.join(rootDir, "scripts/update-inter.ps1"),
    "utf8",
  );

  assert.match(script, /\$Version = "4\.1"/);
  assert.match(script, /FNSMARTZIP_CACHE_ROOT/);
  assert.match(script, /\$defaultCacheRoot/);
  assert.match(script, /Refusing cache path outside workspace/);
  assert.match(script, /Inter-4\.1\.zip/);
  assert.match(script, /\.part/);
  assert.match(script, /Remove-Item[\s\S]*checksum/i);
  assert.match(script, /Move-Item/);
  assert.match(
    script,
    /9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e/,
  );
  assert.match(
    script,
    /693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3/,
  );
  assert.match(
    script,
    /262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a/,
  );
  assert.doesNotMatch(script, /\[IO\.Path\]::GetTempPath/);
  assert.doesNotMatch(script, /\$env:(?:TEMP|TMP)(?!DIR)/);
});

test("provides a release audit for both final FPK packages", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
  const auditScript = fs.readFileSync(
    path.join(rootDir, "scripts/audit-fpk.js"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["test:release"],
    "node scripts/audit-fpk.js",
  );
  for (const fileName of [
    "FnSmartZIP_1.0.0_search-fixed_x86_64.fpk",
    "FnSmartZIP_1.0.0_search-fixed_arm64.fpk",
    "FnSmartZIP_1.0.0_no-search_x86_64.fpk",
    "FnSmartZIP_1.0.0_no-search_arm64.fpk",
  ]) {
    assert.match(
      auditScript,
      new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(auditScript, /InterVariable\.woff2/);
  assert.match(auditScript, /LICENSE-Inter\.txt/);
  assert.match(
    auditScript,
    /693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3/,
  );
  assert.match(
    auditScript,
    /262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a/,
  );
  assert.match(auditScript, /@font-face/);
  assert.match(auditScript, /"Inter Variable"/);
  assert.match(auditScript, /SHA256SUMS\.txt/);
  assert.match(auditScript, /linux-x64/);
  assert.match(auditScript, /linux-arm64/);
  assert.match(auditScript, /unexpected 7-Zip architecture/);
});

test("prepares architecture-specific fnpack staging directories", (t) => {
  const buildRoot = fs.mkdtempSync(path.join(rootDir, ".xinzip-build-"));
  t.after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));

  const x86Stage = prepareStage({
    rootDir,
    buildRoot,
    platform: "x86",
    variant: "search-fixed",
  });
  const armStage = prepareStage({
    rootDir,
    buildRoot,
    platform: "arm",
    variant: "search-fixed",
  });

  assert.equal(path.basename(x86Stage), "FnSmartZIP-search-fixed-x86");
  assert.equal(path.basename(armStage), "FnSmartZIP-search-fixed-arm");
  assert.equal(
    parseManifest(fs.readFileSync(path.join(x86Stage, "manifest"), "utf8")).platform,
    "x86",
  );
  assert.equal(
    fs.existsSync(path.join(x86Stage, "app/vendor/7zip/linux-x64/7zzs")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(x86Stage, "app/vendor/7zip/linux-arm64")),
    false,
  );

  assert.equal(
    parseManifest(fs.readFileSync(path.join(armStage, "manifest"), "utf8")).platform,
    "arm",
  );
  assert.equal(
    fs.existsSync(path.join(armStage, "app/vendor/7zip/linux-arm64/7zzs")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(armStage, "app/vendor/7zip/linux-x64")),
    false,
  );
  for (const stage of [x86Stage, armStage]) {
    assert.equal(
      fs.existsSync(path.join(stage, "app/server/sync-authorized-paths.js")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(stage, "cmd/sync_authorized_paths")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(stage, "app/www/fonts/InterVariable.woff2")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(stage, "app/www/fonts/LICENSE-Inter.txt")),
      true,
    );
    const stack = [stage];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        assert.notEqual(entry.name, ".DS_Store");
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name));
        }
      }
    }
  }
});

test("prepares search-fixed and no-search staging variants", (t) => {
  const buildRoot = fs.mkdtempSync(path.join(rootDir, ".xinzip-variants-"));
  t.after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));

  const searchStage = prepareStage({
    rootDir,
    buildRoot,
    platform: "x86",
    variant: "search-fixed",
  });
  const noSearchStage = prepareStage({
    rootDir,
    buildRoot,
    platform: "x86",
    variant: "no-search",
  });
  const searchHtml = fs.readFileSync(
    path.join(searchStage, "app/www/index.html"),
    "utf8",
  );
  const noSearchHtml = fs.readFileSync(
    path.join(noSearchStage, "app/www/index.html"),
    "utf8",
  );

  assert.match(searchHtml, /id="treeSearchInput"/);
  assert.doesNotMatch(noSearchHtml, /id="treeSearchInput"/);
  assert.match(noSearchHtml, /class="tree-toolbar is-search-disabled"/);
});

test("parses build variants and creates unambiguous package names", () => {
  assert.deepEqual(
    parseArguments(["--variant", "all", "--platform", "all"]).variants,
    ["search-fixed", "no-search"],
  );
  assert.equal(
    packageFileName("1.0.0", "search-fixed", "x86"),
    "FnSmartZIP_1.0.0_search-fixed_x86_64.fpk",
  );
  assert.equal(
    packageFileName("1.0.0", "no-search", "arm"),
    "FnSmartZIP_1.0.0_no-search_arm64.fpk",
  );
});

test("7-Zip updater is pinned to the checksummed release", () => {
  const script = fs.readFileSync(
    path.join(rootDir, "scripts/update-7zip.ps1"),
    "utf8",
  );
  assert.doesNotMatch(script, /^param\(/m);
  assert.match(script, /\$Version = "26\.02"/);
  assert.match(script, /41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e/);
  assert.match(script, /70ea6cc737ae1495ea2d7eb20ef3120fe579bd3f1a83a9d2362b62ec5bde2bba/);
});
