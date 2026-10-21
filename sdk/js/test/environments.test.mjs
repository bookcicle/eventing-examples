import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventingClient, DurableEventQueue } from "../src/index.js";
import { NodeFileEventQueue } from "../src/nodeQueue.js";
const scope = {
  endpoint: "https://example.com/events",
  environment: "test",
  namespace: "general",
};
const options = {
  endpoint: scope.endpoint,
  environment: "test",
  maxRetries: 1,
  flushIntervalMs: 60000,
  maxBatchAgeMs: 60000,
  fetchImpl: async () => ({ status: 503 }),
};

test("durable queue refuses a changed endpoint, environment or namespace before sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eventing-env-")),
    path = join(directory, "queue.json");
  const make = (extras) =>
    createEventingClient({
      ...options,
      queue: new NodeFileEventQueue({ path }),
      ...extras,
    });
  try {
    const first = make();
    const id = await first.track({
      name: "synthetic",
      properties: { marker: "unchanged" },
    });
    const snapshot = await first.getQueueItems();
    await first.close();
    const bytes = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(bytes).scope, scope);
    for (const extra of [
      { environment: "prod" },
      { endpoint: "https://other.example/events" },
      { defaultNamespace: "other" },
    ]) {
      let sends = 0;
      const wrong = make({
        ...extra,
        fetchImpl: async () => {
          sends++;
          return { status: 202 };
        },
      });
      await assert.rejects(wrong.flush(), /scope mismatch/);
      await wrong.close().catch(() => {});
      assert.equal(sends, 0);
      assert.equal(await readFile(path, "utf8"), bytes);
    }
    const sent = [];
    const recovered = make({
      fetchImpl: async (_, init) => {
        sent.push(JSON.parse(init.body));
        return { status: 202 };
      },
    });
    assert.deepEqual(await recovered.getQueueItems(), snapshot);
    assert.equal((await recovered.flush()).flushed, 1);
    assert.equal(sent[0].events[0].event_id, id);
    assert.equal(sent[0].events[0].properties.marker, "unchanged");
    assert.equal("environment" in sent[0], false);
    await recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("IndexedDB default queues isolate environments and custom database names keep their binding", async () => {
  const { IDBFactory } = await import("fake-indexeddb"),
    previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  const clients = [];
  try {
    for (const environment of ["dev", "test", "prod"]) {
      const client = createEventingClient({ ...options, environment });
      clients.push(client);
      await client.track({ name: environment });
      assert.equal((await client.getQueueItems()).length, 1);
    }
    assert.equal((await globalThis.indexedDB.databases()).length, 3);
    const queue = new DurableEventQueue({ dbName: "custom" });
    await queue.bind(scope);
    await queue.enqueue({ event_id: "queued", name: "synthetic" });
    const reopened = new DurableEventQueue({ dbName: "custom" });
    await assert.rejects(
      reopened.bind({ ...scope, environment: "prod" }),
      /scope mismatch/,
    );
    assert.equal((await queue.listAll())[0].event_id, "queued");
  } finally {
    for (const client of clients) await client.close();
    globalThis.indexedDB = previous;
  }
});

test("legacy nonempty file queues fail closed, while empty queues can be bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eventing-legacy-")),
    path = join(directory, "queue.json");
  try {
    const legacy = JSON.stringify([{ event_id: "legacy", name: "synthetic" }]);
    await writeFile(path, legacy);
    await assert.rejects(
      new NodeFileEventQueue({ path }).bind(scope),
      /Unscoped queue/,
    );
    assert.equal(await readFile(path, "utf8"), legacy);
    await writeFile(path, "[]");
    await new NodeFileEventQueue({ path }).bind(scope);
    await assert.rejects(
      new NodeFileEventQueue({ path }).bind({ ...scope, environment: "prod" }),
      /scope mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid environments and unbound custom queue implementations reject", () => {
  for (const environment of ["", "staging", "TEST", null])
    assert.throws(() => createEventingClient({ ...options, environment }));
  assert.throws(() => createEventingClient({ ...options, queue: {} }), /bind/);
});

test("legacy IndexedDB rejection preserves data and the old database version", async () => {
  const { IDBFactory } = await import("fake-indexeddb"),
    previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const db = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open("legacy", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("events", { keyPath: "event_id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("events", "readwrite");
      transaction
        .objectStore("events")
        .put({ event_id: "legacy", name: "synthetic" });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    await assert.rejects(
      new DurableEventQueue({ dbName: "legacy" }).bind(scope),
      /Unscoped queue/,
    );
    const names = await globalThis.indexedDB.databases();
    assert.equal(names.find((db) => db.name === "legacy").version, 1);
  } finally {
    globalThis.indexedDB = previous;
  }
});
