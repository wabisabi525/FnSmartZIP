"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const textFiles = [
  "app/www/index.html",
  "app/www/css/style.css",
  "app/www/js/main.js",
  "app/www/js/password-store.js",
  "app/server/sync-authorized-paths.js",
  "app/server/lib/authorization-paths.js",
  "app/server/lib/paths.js",
  "app/server/lib/source-access.js",
  "app/www/fonts/LICENSE-Inter.txt",
  "scripts/update-inter.ps1",
  "manifest",
  "README.md",
];
const mojibakeFragments = [
  "椋炵墰",
  "鍘嬬缉",
  "瑙ｅ帇",
  "璇疯緭鍏",
  "锛?",
];

for (const relativePath of textFiles) {
  test(`${relativePath} is clean UTF-8 without a BOM or mojibake`, () => {
    const buffer = fs.readFileSync(path.join(rootDir, relativePath));
    const text = buffer.toString("utf8");

    assert.equal(
      buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      false,
      `${relativePath} contains a UTF-8 BOM`,
    );
    assert.equal(text.includes("\uFFFD"), false, `${relativePath} contains U+FFFD`);
    for (const fragment of mojibakeFragments) {
      assert.equal(
        text.includes(fragment),
        false,
        `${relativePath} contains mojibake fragment ${fragment}`,
      );
    }
  });
}
