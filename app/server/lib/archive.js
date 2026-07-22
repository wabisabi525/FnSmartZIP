"use strict";

const path = require("node:path");

const SINGLE_FORMATS = [
  { pattern: /\.tar\.gz$/i, format: "gzip", innerFormat: "tar" },
  { pattern: /\.tar\.bz2$/i, format: "bzip2", innerFormat: "tar" },
  { pattern: /\.tar\.xz$/i, format: "xz", innerFormat: "tar" },
  { pattern: /\.tar\.(?:zst|zstd)$/i, format: "zstd", innerFormat: "tar" },
  { pattern: /\.7z$/i, format: "7z", type: "7z" },
  { pattern: /\.zip$/i, format: "zip", type: "zip" },
  { pattern: /\.rar$/i, format: "rar", type: "rar" },
  { pattern: /\.tar$/i, format: "tar", type: "tar" },
  { pattern: /\.tgz$/i, format: "gzip", innerFormat: "tar" },
  { pattern: /\.gz$/i, format: "gzip" },
  { pattern: /\.(?:tbz|tbz2)$/i, format: "bzip2", innerFormat: "tar" },
  { pattern: /\.bz2$/i, format: "bzip2" },
  { pattern: /\.txz$/i, format: "xz", innerFormat: "tar" },
  { pattern: /\.xz$/i, format: "xz" },
  { pattern: /\.tzst$/i, format: "zstd", innerFormat: "tar" },
  { pattern: /\.(?:zst|zstd)$/i, format: "zstd" },
  { pattern: /\.cab$/i, format: "cab", type: "cab" },
  { pattern: /\.iso$/i, format: "iso", type: "iso" },
  { pattern: /\.arj$/i, format: "arj", type: "arj" },
  { pattern: /\.(?:lzh|lha)$/i, format: "lzh", type: "lzh" },
];

function stripKnownExtension(name) {
  for (const entry of SINGLE_FORMATS) {
    if (entry.pattern.test(name)) {
      return name.replace(entry.pattern, "");
    }
  }
  return name;
}

function detectInnerSplitFormat(stem) {
  if (/\.7z$/i.test(stem)) {
    return { format: "7z", type: "7z.split" };
  }
  if (/\.zip$/i.test(stem)) {
    return { format: "zip", type: "zip.split" };
  }
  if (/\.rar$/i.test(stem)) {
    return { format: "rar", type: "rar.split" };
  }
  return { format: null, type: null };
}

function classifyArchive(filePath) {
  const basename = path.basename(filePath);

  const rarParts = basename.match(/^(.*)\.part(\d+)\.rar$/i);
  if (rarParts) {
    const partText = rarParts[2];
    const partNumber = Number(partText);
    if (partNumber < 1) {
      return null;
    }
    return {
      kind: "rar-parts",
      format: "rar",
      type: "rar",
      basename,
      seriesStem: rarParts[1],
      outputStem: rarParts[1],
      partNumber,
      partWidth: partText.length,
      firstVolumeName: `${rarParts[1]}.part${String(1).padStart(partText.length, "0")}.rar`,
    };
  }

  const numericSplit = basename.match(/^(.*)\.(\d{3,})$/);
  if (numericSplit) {
    const partNumber = Number(numericSplit[2]);
    if (partNumber < 1) {
      return null;
    }
    const inner = detectInnerSplitFormat(numericSplit[1]);
    return {
      kind: "split",
      format: inner.format,
      type: inner.type,
      basename,
      seriesStem: numericSplit[1],
      outputStem: stripKnownExtension(numericSplit[1]),
      partNumber,
      partWidth: numericSplit[2].length,
      firstVolumeName: `${numericSplit[1]}.${String(1).padStart(numericSplit[2].length, "0")}`,
    };
  }

  const zipPart = basename.match(/^(.*)\.z(\d{2,})$/i);
  if (zipPart) {
    return {
      kind: "zip-z",
      format: "zip",
      type: "zip",
      basename,
      seriesStem: zipPart[1],
      outputStem: zipPart[1],
      partNumber: Number(zipPart[2]),
      partWidth: zipPart[2].length,
      firstVolumeName: `${zipPart[1]}.zip`,
    };
  }

  const oldRarPart = basename.match(/^(.*)\.r(\d{2,})$/i);
  if (oldRarPart) {
    return {
      kind: "rar-old",
      format: "rar",
      type: "rar",
      basename,
      seriesStem: oldRarPart[1],
      outputStem: oldRarPart[1],
      partNumber: Number(oldRarPart[2]) + 2,
      partWidth: oldRarPart[2].length,
      firstVolumeName: `${oldRarPart[1]}.rar`,
    };
  }

  for (const entry of SINGLE_FORMATS) {
    if (entry.pattern.test(basename)) {
      const outputStem = basename.replace(entry.pattern, "");
      return {
        kind: "single",
        format: entry.format,
        type: entry.type || null,
        innerFormat: entry.innerFormat || null,
        basename,
        outputStem,
        partNumber: 1,
        firstVolumeName: basename,
      };
    }
  }

  return null;
}

function missingRange(present, start, end) {
  const values = new Set(present);
  const missing = [];
  for (let value = start; value <= end; value += 1) {
    if (!values.has(value)) {
      missing.push(value);
    }
  }
  return missing;
}

function collectVolumeNames(selection, directoryNames) {
  if (!selection) {
    return { names: [], missingParts: [], firstVolumeName: "" };
  }

  if (selection.kind === "split") {
    const escaped = escapeRegExp(selection.seriesStem);
    const matcher = new RegExp(`^${escaped}\\.(\\d{3,})$`, "i");
    const matches = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    const maxPart = matches.length ? matches.at(-1).part : 0;
    return {
      names: matches.map((entry) => entry.name),
      missingParts: missingRange(matches.map((entry) => entry.part), 1, maxPart),
      firstVolumeName: selection.firstVolumeName,
    };
  }

  if (selection.kind === "rar-parts") {
    const escaped = escapeRegExp(selection.seriesStem);
    const matcher = new RegExp(`^${escaped}\\.part(\\d+)\\.rar$`, "i");
    const matches = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    const maxPart = matches.length ? matches.at(-1).part : 0;
    return {
      names: matches.map((entry) => entry.name),
      missingParts: missingRange(matches.map((entry) => entry.part), 1, maxPart),
      firstVolumeName: selection.firstVolumeName,
    };
  }

  const stem = selection.seriesStem || selection.outputStem;
  if (selection.format === "zip" && /\.zip$/i.test(selection.firstVolumeName)) {
    const escaped = escapeRegExp(stem);
    const matcher = new RegExp(`^${escaped}\\.z(\\d{2,})$`, "i");
    const parts = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    if (parts.length) {
      const maxPart = parts.at(-1).part;
      const mainName = `${stem}.zip`;
      return {
        names: [...parts.map((entry) => entry.name), mainName]
          .filter((name) => directoryNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase())),
        missingParts: missingRange(parts.map((entry) => entry.part), 1, maxPart),
        firstVolumeName: mainName,
      };
    }
  }

  if (selection.format === "rar" && /\.rar$/i.test(selection.firstVolumeName)) {
    const escaped = escapeRegExp(stem);
    const matcher = new RegExp(`^${escaped}\\.r(\\d{2,})$`, "i");
    const parts = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    if (parts.length) {
      const maxPart = parts.at(-1).part;
      const mainName = `${stem}.rar`;
      return {
        names: [mainName, ...parts.map((entry) => entry.name)]
          .filter((name) => directoryNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase())),
        missingParts: missingRange(parts.map((entry) => entry.part), 0, maxPart),
        firstVolumeName: mainName,
      };
    }
  }

  const selectedName = directoryNames.find(
    (name) => name.toLowerCase() === selection.basename.toLowerCase(),
  );
  return {
    names: selectedName ? [selectedName] : [],
    missingParts: [],
    firstVolumeName: selection.firstVolumeName,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  SINGLE_FORMATS,
  classifyArchive,
  collectVolumeNames,
  stripKnownExtension,
};
