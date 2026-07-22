"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  STORAGE_KEY,
  createPasswordStore,
} = require("../app/www/js/password-store");

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("persists saved passwords across store instances", () => {
  const storage = createMemoryStorage();
  const first = createPasswordStore(storage, {
    now: () => "2026-07-21T01:00:00.000Z",
    randomId: () => "first-id",
  });

  const saved = first.save({
    label: "NAS 下载密码",
    password: "secret-one",
    archiveKey: "movie.7z",
  });
  assert.equal(saved.id, "first-id");

  const second = createPasswordStore(storage);
  assert.deepEqual(second.list(), [{
    id: "first-id",
    label: "NAS 下载密码",
    password: "secret-one",
    archiveKey: "movie.7z",
    createdAt: "2026-07-21T01:00:00.000Z",
    lastUsedAt: "2026-07-21T01:00:00.000Z",
  }]);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test("selects the most recently used password for an archive", () => {
  const storage = createMemoryStorage();
  let now = "2026-07-21T01:00:00.000Z";
  let nextId = 0;
  const store = createPasswordStore(storage, {
    now: () => now,
    randomId: () => `id-${++nextId}`,
  });
  const oldEntry = store.save({
    label: "旧密码",
    password: "old",
    archiveKey: "movie.zip",
  });
  now = "2026-07-21T02:00:00.000Z";
  const newEntry = store.save({
    label: "新密码",
    password: "new",
    archiveKey: "movie.zip",
  });
  now = "2026-07-21T03:00:00.000Z";
  store.touch(oldEntry.id);

  assert.equal(store.matchArchive("movie.zip").id, oldEntry.id);
  assert.equal(store.get(newEntry.id).password, "new");
});

test("deletes individual passwords and clears the password list", () => {
  const storage = createMemoryStorage();
  let nextId = 0;
  const store = createPasswordStore(storage, {
    randomId: () => `id-${++nextId}`,
  });
  const first = store.save({ label: "一", password: "one" });
  store.save({ label: "二", password: "two" });

  assert.equal(store.remove(first.id), true);
  assert.deepEqual(store.list().map((entry) => entry.label), ["二"]);
  store.clear();
  assert.deepEqual(store.list(), []);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("rejects empty passwords and recovers from corrupt storage", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, "{broken");
  const store = createPasswordStore(storage);

  assert.deepEqual(store.list(), []);
  assert.throws(
    () => store.save({ label: "空密码", password: "" }),
    /密码/,
  );
});

test("contains browser storage write failures", () => {
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  const store = createPasswordStore(storage, {
    randomId: () => "id-1",
  });

  assert.equal(store.save({ label: "密码", password: "secret" }), null);
  assert.equal(store.touch("id-1"), null);
  assert.equal(store.remove("id-1"), false);
  assert.equal(store.clear(), false);
  assert.deepEqual(store.list(), []);
});

test("updates an existing saved password without creating a duplicate", () => {
  const storage = createMemoryStorage();
  let now = "2026-07-21T01:00:00.000Z";
  const store = createPasswordStore(storage, {
    now: () => now,
    randomId: () => "password-id",
  });
  const saved = store.save({
    label: "旧名称",
    password: "old-secret",
    archiveKey: "archive.zip",
  });

  now = "2026-07-21T02:00:00.000Z";
  const updated = store.save({
    id: saved.id,
    label: "新名称",
    password: "new-secret",
    archiveKey: "archive.zip",
  });

  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, "2026-07-21T01:00:00.000Z");
  assert.equal(updated.lastUsedAt, "2026-07-21T02:00:00.000Z");
  assert.deepEqual(store.list().map((entry) => entry.label), ["新名称"]);
  assert.equal(store.get(saved.id).password, "new-secret");
});
