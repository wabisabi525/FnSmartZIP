"use strict";

const CODE_PAGES = Object.freeze({
  auto: null,
  utf8: 65001,
  gbk: 936,
  big5: 950,
  shift_jis: 932,
  korean: 949,
});

function normalizeCodePage(value = "auto") {
  const id = String(value || "auto").toLowerCase();
  if (!Object.hasOwn(CODE_PAGES, id)) {
    throw new Error("不支持的代码页选项");
  }
  return { id, codePage: CODE_PAGES[id] };
}

function appendArchiveOptions(args, selection, options) {
  if (selection.type) {
    args.push(`-t${selection.type}`);
  }

  const codePage = normalizeCodePage(options.codePage);
  if (selection.format === "zip" && codePage.codePage) {
    args.push(`-mcp=${codePage.codePage}`);
  }

  if (options.password) {
    args.push(`-p${options.password}`);
  }
}

function buildListArgs(selection, options) {
  const args = ["l", "-slt", "-sccUTF-8"];
  appendArchiveOptions(args, selection, options);
  args.push(options.archivePath);
  return args;
}

function buildTestArgs(selection, options) {
  const args = ["t", "-mmt=on", "-sccUTF-8"];
  appendArchiveOptions(args, selection, options);
  args.push(options.archivePath);
  return args;
}

function buildExtractArgs(selection, options) {
  const args = [
    "x",
    "-y",
    "-aou",
    "-mmt=on",
    "-bsp1",
    "-bb1",
    "-sccUTF-8",
  ];
  appendArchiveOptions(args, selection, options);

  if (options.selectionFile) {
    args.push(
      "-scsUTF-8",
      "-spd",
      `-i@${options.selectionFile}`,
    );
  }

  args.push(`-o${options.outputDir}`, options.archivePath);
  return args;
}

module.exports = {
  CODE_PAGES,
  buildExtractArgs,
  buildListArgs,
  buildTestArgs,
  normalizeCodePage,
};
