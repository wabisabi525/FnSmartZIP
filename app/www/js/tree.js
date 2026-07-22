(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.XinZipTree = api;
    }
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    function compareNodes(a, b) {
        if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
        });
    }

    function buildTree(entries) {
        const rootNode = {
            path: "",
            name: "",
            type: "directory",
            children: [],
        };
        const nodes = new Map([["", rootNode]]);

        for (const entry of entries || []) {
            const normalizedPath = String(entry.path || "").replace(/\\/g, "/");
            if (!normalizedPath) {
                continue;
            }
            const segments = normalizedPath.split("/");
            let parentPath = "";
            for (let index = 0; index < segments.length; index += 1) {
                const nodePath = segments.slice(0, index + 1).join("/");
                const isLeaf = index === segments.length - 1;
                let node = nodes.get(nodePath);
                if (!node) {
                    node = {
                        path: nodePath,
                        name: segments[index],
                        parentPath,
                        type: isLeaf ? entry.type : "directory",
                        size: isLeaf ? Number(entry.size || 0) : 0,
                        packedSize: isLeaf ? Number(entry.packedSize || 0) : 0,
                        modified: isLeaf ? (entry.modified || "") : "",
                        encrypted: isLeaf ? Boolean(entry.encrypted) : false,
                        children: [],
                    };
                    nodes.set(nodePath, node);
                    nodes.get(parentPath).children.push(node);
                } else if (isLeaf) {
                    Object.assign(node, {
                        ...entry,
                        path: nodePath,
                        name: segments[index],
                        parentPath,
                        children: node.children || [],
                    });
                }
                parentPath = nodePath;
            }
        }

        for (const node of nodes.values()) {
            node.children.sort(compareNodes);
        }
        return rootNode.children;
    }

    function collectDescendantFiles(node) {
        if (!node) {
            return [];
        }
        if (node.type === "file") {
            return [node.path];
        }
        return (node.children || []).flatMap(collectDescendantFiles);
    }

    function selectionState(node, selectedPaths) {
        const files = collectDescendantFiles(node);
        if (files.length === 0) {
            return "unchecked";
        }
        const selectedCount = files.filter((filePath) => selectedPaths.has(filePath)).length;
        if (selectedCount === 0) {
            return "unchecked";
        }
        if (selectedCount === files.length) {
            return "checked";
        }
        return "mixed";
    }

    function cloneNode(node, children) {
        return {
            ...node,
            children,
        };
    }

    function filterTree(nodes, query) {
        const needle = String(query || "").trim().toLocaleLowerCase();
        if (!needle) {
            return nodes;
        }

        const result = [];
        for (const node of nodes) {
            const matches = node.path.toLocaleLowerCase().includes(needle);
            if (matches) {
                result.push(cloneNode(node, node.children));
                continue;
            }
            const children = filterTree(node.children || [], needle);
            if (children.length) {
                result.push(cloneNode(node, children));
            }
        }
        return result;
    }

    function searchFiles(entries, query) {
        const needle = String(query || "").trim().toLocaleLowerCase();
        if (!needle) {
            return [];
        }

        const matches = [];
        for (const entry of entries || []) {
            if (entry.type !== "file") {
                continue;
            }
            const normalizedPath = String(entry.path || "").replace(/\\/g, "/");
            const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
            if (fileName.toLocaleLowerCase().includes(needle)) {
                matches.push(entry);
            }
        }
        return matches;
    }

    function createSearchScheduler(options = {}) {
        const delay = Number(options.delay || 180);
        const setTimer = options.setTimer || setTimeout;
        const clearTimer = options.clearTimer || clearTimeout;
        let timer = null;
        let generation = 0;

        return {
            schedule(callback) {
                generation += 1;
                const scheduledGeneration = generation;
                if (timer !== null) {
                    clearTimer(timer);
                }
                timer = setTimer(() => {
                    timer = null;
                    if (scheduledGeneration === generation) {
                        callback(scheduledGeneration);
                    }
                }, delay);
                return scheduledGeneration;
            },
            cancel() {
                generation += 1;
                if (timer !== null) {
                    clearTimer(timer);
                    timer = null;
                }
            },
            isCurrent(candidate) {
                return candidate === generation;
            },
        };
    }

    function renderBatches(items, options) {
        const batchSize = Math.max(1, Number(options.batchSize || 200));
        const scheduleFrame = options.scheduleFrame;
        const isCurrent = options.isCurrent;
        const renderBatch = options.renderBatch;
        let index = 0;

        function renderNextBatch() {
            if (!isCurrent()) {
                return;
            }
            const nextIndex = Math.min(index + batchSize, items.length);
            renderBatch(items.slice(index, nextIndex));
            index = nextIndex;
            if (index < items.length && isCurrent()) {
                scheduleFrame(renderNextBatch);
            }
        }

        if (items.length && isCurrent()) {
            scheduleFrame(renderNextBatch);
        }
    }

    return {
        buildTree,
        collectDescendantFiles,
        createSearchScheduler,
        filterTree,
        renderBatches,
        searchFiles,
        selectionState,
    };
}));
