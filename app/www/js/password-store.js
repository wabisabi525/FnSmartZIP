(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.FnSmartZIPPasswordStore = api;
    }
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const STORAGE_KEY = "fnsmartzip.passwords.v1";
    const MAX_ENTRIES = 50;

    function defaultRandomId() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
        return `password-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function validEntry(entry) {
        return entry
            && typeof entry.id === "string"
            && typeof entry.label === "string"
            && typeof entry.password === "string"
            && typeof entry.createdAt === "string"
            && typeof entry.lastUsedAt === "string";
    }

    function createPasswordStore(storage, options = {}) {
        const now = options.now || (() => new Date().toISOString());
        const randomId = options.randomId || defaultRandomId;

        function read() {
            try {
                const raw = storage.getItem(STORAGE_KEY);
                if (!raw) {
                    return [];
                }
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed.filter(validEntry) : [];
            } catch (error) {
                return [];
            }
        }

        function write(entries) {
            try {
                if (!entries.length) {
                    storage.removeItem(STORAGE_KEY);
                    return true;
                }
                storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
                return true;
            } catch (error) {
                return false;
            }
        }

        function list() {
            return read()
                .slice()
                .sort((a, b) => (
                    b.lastUsedAt.localeCompare(a.lastUsedAt)
                    || a.label.localeCompare(b.label, undefined, {
                        numeric: true,
                        sensitivity: "base",
                    })
                ));
        }

        function get(id) {
            return read().find((entry) => entry.id === id) || null;
        }

        function save(input) {
            const password = String(input.password || "");
            if (!password) {
                throw new Error("保存的密码不能为空");
            }
            const timestamp = now();
            const entries = read();
            const existingIndex = input.id
                ? entries.findIndex((entry) => entry.id === input.id)
                : -1;
            const existing = existingIndex >= 0 ? entries[existingIndex] : null;
            const entry = {
                id: existing?.id || randomId(),
                label: String(input.label || "").trim() || "已保存密码",
                password,
                archiveKey: String(input.archiveKey || ""),
                createdAt: existing?.createdAt || timestamp,
                lastUsedAt: timestamp,
            };
            if (existingIndex >= 0) {
                entries.splice(existingIndex, 1, entry);
            } else {
                entries.unshift(entry);
            }
            entries.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
            if (!write(entries)) {
                return null;
            }
            return { ...entry };
        }

        function touch(id) {
            const entries = read();
            const index = entries.findIndex((entry) => entry.id === id);
            if (index < 0) {
                return null;
            }
            entries[index] = {
                ...entries[index],
                lastUsedAt: now(),
            };
            if (!write(entries)) {
                return null;
            }
            return { ...entries[index] };
        }

        function matchArchive(archiveKey) {
            const key = String(archiveKey || "");
            if (!key) {
                return null;
            }
            return list().find((entry) => entry.archiveKey === key) || null;
        }

        function remove(id) {
            const entries = read();
            const filtered = entries.filter((entry) => entry.id !== id);
            if (filtered.length === entries.length) {
                return false;
            }
            return write(filtered);
        }

        function clear() {
            return write([]);
        }

        return {
            clear,
            get,
            list,
            matchArchive,
            remove,
            save,
            touch,
        };
    }

    return {
        MAX_ENTRIES,
        STORAGE_KEY,
        createPasswordStore,
    };
}));
