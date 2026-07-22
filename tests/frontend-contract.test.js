"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(rootDir, "app/www/index.html"), "utf8");
const css = fs.readFileSync(path.join(rootDir, "app/www/css/style.css"), "utf8");
const mainJs = fs.readFileSync(path.join(rootDir, "app/www/js/main.js"), "utf8");

test("exposes the complete code page selector", () => {
  const expected = [
    ["auto", "默认（自动识别）"],
    ["utf8", "UTF-8"],
    ["gbk", "简体中文（GBK / 936）"],
    ["big5", "繁体中文（Big5 / 950）"],
    ["shift_jis", "日文（Shift-JIS / 932）"],
    ["korean", "韩文（949）"],
  ];
  for (const [value, label] of expected) {
    assert.match(
      html,
      new RegExp(`<option value="${value}">${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</option>`),
    );
  }
});

test("provides saved password selection and management controls", () => {
  for (const id of [
    "passwordPromptDialog",
    "passwordInput",
    "passwordPresetToggleBtn",
    "passwordPresetList",
    "showPasswordInput",
    "openPasswordManagerFromPromptBtn",
    "passwordManagerDialog",
    "passwordRecordList",
    "addPasswordBtn",
    "editPasswordBtn",
    "deletePasswordBtn",
    "passwordRecordDialog",
    "recordPasswordInput",
    "recordLabelInput",
    "confirmPasswordRecordBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(
    html.indexOf("js/password-store.js") < html.indexOf("js/main.js"),
    "password store must load before main.js",
  );
});

test("uses the FnSmartZIP brand and Chinese subtitle", () => {
  assert.match(html, /<title>FnSmartZIP - 飞牛智能分卷解压<\/title>/);
  assert.match(html, /<h1>FnSmartZIP<\/h1>/);
  assert.match(html, />飞牛智能分卷解压</);
  assert.match(
    html,
    /src="\.\/index\.cgi\/images\/icon_64\.png\?v=1\.0\.0"/,
    "the brand icon must be served through the CGI static-file route",
  );
});

test("stacks the header on narrow mobile viewports", () => {
  const mobileRule = css.match(/@media \(max-width: 680px\) \{([\s\S]*)\}\s*$/);
  assert.ok(mobileRule, "missing the narrow mobile media query");
  assert.match(
    mobileRule[1],
    /\.app-header\s*\{[^}]*flex-direction:\s*column;/,
  );
  assert.doesNotMatch(
    css,
    /html\s*\{[^}]*min-width:\s*320px;/,
    "320px viewports must not gain page-level horizontal overflow",
  );
});

test("keeps password verification request-scoped without automatic saving", () => {
  assert.match(mainJs, /previewRequestId/);
  assert.match(mainJs, /rememberPasswordAfterSuccessfulPreview\(previewRequest\)/);
  assert.match(mainJs, /if \(previewRequest\.id !== state\.previewRequestId\)/);
  const rememberFunction = mainJs.match(
    /function rememberPasswordAfterSuccessfulPreview[\s\S]*?\n    \}/,
  )?.[0] || "";
  assert.doesNotMatch(
    rememberFunction,
    /passwordStore\.save/,
    "successful preview must not automatically create or overwrite a password",
  );
});

test("provides diagnostic viewing, copying and download controls", () => {
  for (const id of [
    "diagnosticsBtn",
    "diagnosticsDialog",
    "diagnosticsContent",
    "copyDiagnosticsBtn",
    "downloadDiagnosticsBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(mainJs, /apiUrl\("diagnostics"/);
  assert.match(mainJs, /navigator\.clipboard\.writeText/);
  assert.match(mainJs, /URL\.createObjectURL/);
});

test("tracks password verification and interrupted preview fallback", () => {
  assert.match(mainJs, /passwordRequired/);
  assert.match(mainJs, /passwordVerified/);
  assert.match(mainJs, /PREVIEW_INTERRUPTED/);
  assert.match(mainJs, /预览被系统中断，可整包解压/);
  assert.match(mainJs, /invalidatePasswordVerification/);
  assert.match(mainJs, /selectPasswordPreset[\s\S]*invalidatePasswordVerification/);
});

test("surfaces request ids from API failures", () => {
  assert.match(mainJs, /data\.requestId/);
  assert.match(mainJs, /error\.requestId/);
});

test("falls back to legacy copy behavior on insecure HTTP origins", () => {
  assert.match(mainJs, /navigator\.clipboard\?\.writeText/);
  assert.match(mainJs, /document\.execCommand\("copy"\)/);
  assert.match(
    mainJs,
    /navigator\.clipboard\?\.writeText[\s\S]*catch[\s\S]*copyTextWithLegacyFallback/,
  );
});

test("password management keeps verification state consistent", () => {
  const saveFunction = mainJs.match(
    /function savePasswordRecord[\s\S]*?\n    \}/,
  )?.[0] || "";
  const deleteFunction = mainJs.match(
    /function deleteSelectedPassword[\s\S]*?\n    \}/,
  )?.[0] || "";

  assert.match(saveFunction, /passwordStore\.save/);
  assert.match(
    deleteFunction,
    /invalidatePasswordVerification/,
    "deleting the active password must revoke verification",
  );
});

test("uses the balanced blue visual direction", () => {
  assert.match(css, /--accent:\s*#2786dc;/i);
  assert.match(css, /--accent-dark:\s*#[0-9a-f]{6};/i);
  assert.match(html, /class="brand-icon"/);
});

test("uses a Fluent-compatible cross-platform typography stack", () => {
  assert.match(
    css,
    /@font-face\s*\{[^}]*font-family:\s*"Inter Variable";[^}]*src:\s*url\("\.\.\/fonts\/InterVariable\.woff2\?v=4\.1"\)\s*format\("woff2"\);[^}]*font-weight:\s*100 900;[^}]*font-display:\s*swap;/,
  );
  assert.match(
    css,
    /--font-ui:\s*"Inter Variable",\s*"Inter",\s*"Segoe UI Variable Text",\s*"Segoe UI Variable",\s*"Segoe UI",\s*"Microsoft YaHei UI",\s*"Microsoft YaHei",\s*"PingFang SC",\s*"Hiragino Sans GB",\s*"Noto Sans CJK SC",\s*"Noto Sans SC",\s*Arial,\s*sans-serif;/,
  );
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-ui\);/);
  assert.match(css, /body\s*\{[^}]*font-weight:\s*400;/);
  assert.match(css, /body\s*\{[^}]*line-height:\s*1\.45;/);
  assert.match(css, /body\s*\{[^}]*-webkit-font-smoothing:\s*antialiased;/);
  assert.match(css, /body\s*\{[^}]*-moz-osx-font-smoothing:\s*grayscale;/);
  assert.match(css, /body\s*\{[^}]*text-rendering:\s*optimizeLegibility;/);
  assert.match(css, /body\s*\{[^}]*font-kerning:\s*normal;/);
  assert.match(css, /body\s*\{[^}]*font-optical-sizing:\s*auto;/);
  assert.doesNotMatch(css, /@font-face\s*\{[^}]*https?:\/\//);
  assert.match(
    css,
    /\.text-danger-button\s*\{[^}]*font-weight:\s*600;/,
  );
  assert.match(
    css,
    /\.archive-metrics dd,[\s\S]*#progressText[\s\S]*font-variant-numeric:\s*lining-nums tabular-nums;/,
  );
});

test("moves filename code page to the bottom of the settings panel", () => {
  const settings = html.match(
    /<div class="settings-form">([\s\S]*?)<\/div>\s*<\/aside>/,
  )?.[1] || "";

  assert.ok(settings.indexOf("密码管理器") >= 0);
  assert.ok(settings.indexOf("选择解压路径") > settings.indexOf("密码管理器"));
  assert.ok(settings.indexOf("输出位置预览") > settings.indexOf("选择解压路径"));
  assert.ok(settings.indexOf("已识别分卷") > settings.indexOf("输出位置预览"));
  assert.ok(settings.indexOf("文件名代码页") > settings.indexOf("已识别分卷"));
});

test("keeps desktop work panels aligned and uses concise extraction copy", () => {
  assert.match(
    css,
    /\.work-grid\s*\{[^}]*align-items:\s*stretch;/,
    "desktop work panels should share the same grid-row height",
  );
  assert.match(
    css,
    /\.settings-panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/,
    "the settings panel should fill the desktop grid row",
  );
  assert.doesNotMatch(html, /仅用于 ZIP 家族的文件名解析。/);
  assert.match(html, /解压到压缩包同名目录/);
});

test("keeps the desktop settings controls compact without changing panel height", () => {
  assert.match(
    css,
    /\.settings-form\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*14px;[^}]*padding:\s*14px;/,
  );
  assert.match(css, /\.code-page-field\s*\{[^}]*margin-top:\s*auto;/);
  assert.match(
    css,
    /#openPasswordManagerBtn\s*\{[^}]*font-size:\s*12px;/,
  );
  assert.match(css, /\.directory-picker-summary\s*\{[^}]*min-width:\s*0;/);
  assert.match(
    css,
    /\.notice-row\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;/,
    "a hidden diagnostics button must not leave a phantom grid gap",
  );
  assert.match(css, /\.notice\s*\{[^}]*flex:\s*1;/);
});

test("collapses unused volume spacing without changing the expanded layout", () => {
  assert.match(
    css,
    /\.code-page-field\s*\{[^}]*margin-top:\s*0;/,
  );
  assert.match(
    css,
    /\.volume-details\[open\]\s*\+\s*\.code-page-field\s*\{[^}]*margin-top:\s*auto;/,
  );
});

test("uses a compact responsive search field and shorter desktop file tree", () => {
  assert.match(
    css,
    /\.tree-toolbar\s*\{[^}]*grid-template-columns:\s*auto minmax\(180px,\s*280px\);/,
  );
  assert.match(
    css,
    /\.search-field input\s*\{[^}]*min-height:\s*36px;/,
  );
  assert.match(css, /\.file-tree\s*\{[^}]*height:\s*400px;/);
  assert.match(
    css,
    /@media \(max-width:\s*860px\)[\s\S]*?\.file-tree\s*\{[^}]*height:\s*380px;/,
  );
});

test("debounces flat file search and renders cancellable batches", () => {
  assert.match(mainJs, /createSearchScheduler\(\{\s*delay:\s*180/);
  assert.match(mainJs, /treeApi\.searchFiles\(state\.entries,\s*query\)/);
  assert.match(mainJs, /treeApi\.renderBatches/);
  assert.match(mainJs, /function appendSearchFileRow/);
  assert.doesNotMatch(
    mainJs,
    /collectVisibleDirectories\(visibleTree,\s*state\.expandedPaths\)/,
  );
  const searchRenderer = mainJs.match(
    /function renderSearchResults[\s\S]*?\n    \}/,
  )?.[0] || "";
  const searchRowRenderer = mainJs.match(
    /function appendSearchFileRow[\s\S]*?\n    \}/,
  )?.[0] || "";
  assert.doesNotMatch(searchRenderer, /expandedPaths\.(?:add|delete|clear)/);
  assert.match(searchRowRenderer, /selectedPaths\.add\(entry\.path\)/);
  assert.match(searchRowRenderer, /selectedPaths\.delete\(entry\.path\)/);
  assert.doesNotMatch(searchRowRenderer, /collectDescendantFiles/);
  assert.match(mainJs, /searchScheduler\.cancel\(\)/);
});

test("provides a central lazy directory tree picker", () => {
  assert.doesNotMatch(html, /id="destinationRootSelect"/);
  assert.doesNotMatch(html, /id="browseDirectoryBtn"/);
  for (const id of [
    "selectedDirectoryPath",
    "openDirectoryPickerBtn",
    "directoryDialog",
    "directoryDialogPath",
    "directoryTree",
    "refreshDirectoryRootsBtn",
    "directoryUpBtn",
    "createDirectoryBtn",
    "chooseDirectoryBtn",
    "createDirectoryDialog",
    "createDirectoryNameInput",
    "confirmCreateDirectoryBtn",
    "cancelCreateDirectoryBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(mainJs, /function renderDirectoryTree/);
  assert.match(mainJs, /async function loadDirectoryChildren/);
  assert.match(mainJs, /async function revealDirectoryPath/);
  assert.match(mainJs, /async function refreshDirectoryRoots/);
  assert.match(mainJs, /async function createDirectory/);
  assert.match(mainJs, /directoryRequestId/);
  assert.match(css, /\.directory-dialog\s*\{[^}]*width:\s*min\(640px,\s*100%\)/);
  assert.match(css, /\.directory-tree\s*\{[^}]*overflow:\s*auto;/);
});

test("provides a complete password manager dialog", () => {
  for (const id of [
    "passwordManagerStatus",
    "openPasswordManagerBtn",
    "passwordPromptDialog",
    "closePasswordPromptDialogBtn",
    "passwordPresetToggleBtn",
    "passwordPresetList",
    "showPasswordInput",
    "openPasswordManagerFromPromptBtn",
    "verifyPasswordBtn",
    "cancelPasswordBtn",
    "passwordPromptError",
    "passwordManagerDialog",
    "closePasswordManagerDialogBtn",
    "passwordRecordList",
    "addPasswordBtn",
    "editPasswordBtn",
    "deletePasswordBtn",
    "confirmPasswordManagerBtn",
    "passwordRecordDialog",
    "closePasswordRecordDialogBtn",
    "recordPasswordInput",
    "recordLabelInput",
    "confirmPasswordRecordBtn",
    "cancelPasswordRecordBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.doesNotMatch(html, /设置主密码|删除主密码/);
  assert.match(mainJs, /function openPasswordPrompt/);
  assert.match(mainJs, /function closePasswordPrompt/);
  assert.match(mainJs, /function togglePasswordPresetList/);
  assert.match(mainJs, /function selectPasswordPreset/);
  assert.match(mainJs, /function openPasswordManager/);
  assert.match(mainJs, /function closePasswordManager/);
  assert.match(mainJs, /function openPasswordRecordDialog/);
  assert.match(mainJs, /function savePasswordRecord/);
  assert.match(mainJs, /function verifyPasswordAndPreview/);
  assert.match(
    mainJs,
    /closePasswordPrompt\(true\)/,
    "successful verification must force-close the busy password prompt",
  );
});

test("provides actionable ACL permission guidance", () => {
  for (const id of [
    "permissionDialog",
    "permissionDialogMessage",
    "retryPermissionBtn",
    "permissionDiagnosticsBtn",
    "closePermissionDialogBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /FnSmartZIP 无法读取此文件/);
  assert.match(mainJs, /SOURCE_FILE_DENIED/);
  assert.match(mainJs, /SOURCE_PARENT_DENIED/);
  assert.match(mainJs, /function openPermissionDialog/);
  assert.match(html, /详细信息.*权限.*新增.*应用/);
  assert.match(mainJs, /当前文件未授予 FnSmartZIP 读取权限/);
  assert.doesNotMatch(
    mainJs,
    /目录授权不会自动更新已有文件的 ACL。请在/,
    "permission summary should not repeat the full step sequence",
  );

  const openDirectoryFunction = mainJs.match(
    /async function openDirectoryDialog[\s\S]*?\n    \}/,
  )?.[0] || "";
  const goUpFunction = mainJs.match(
    /async function goUpDirectory[\s\S]*?\n    \}/,
  )?.[0] || "";
  assert.match(
    openDirectoryFunction,
    /handlePermissionError/,
    "directory browsing permission failures must open the ACL dialog",
  );
  assert.match(
    goUpFunction,
    /handlePermissionError/,
    "parent directory navigation permission failures must open the ACL dialog",
  );
});

test("protects compact labels and buttons from awkward wrapping", () => {
  assert.match(css, /\.primary-button,[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /\.password-manager-summary[\s\S]*min-width:\s*0;/);
  assert.match(css, /\.path-text[\s\S]*text-overflow:\s*ellipsis;/);
  assert.match(
    css,
    /\.password-prompt-dialog\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/,
  );
  assert.match(
    css,
    /\.password-prompt-body\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/,
  );
});
