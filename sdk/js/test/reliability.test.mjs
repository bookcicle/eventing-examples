import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createEventingClient, DurableEventQueue } from "../src/index.js";
import { NodeFileEventQueue } from "../src/nodeQueue.js";
const contract = JSON.parse(
  await readFile(new URL("../../contract/cases.json", import.meta.url)),
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function client(t, opts = {}) {
  const c = createEventingClient({
    endpoint: "https://example.com/events",
    queue: new DurableEventQueue({ storage: "memory" }),
    flushIntervalMs: 60000,
    maxBatchAgeMs: 60000,
    baseBackoffMs: 0,
    ...opts,
  });
  t.after(() => c.close().catch(() => {}));
  return c;
}
for (const c of contract.retry_cases)
  test(`shared retry contract ${c.statuses}`, async (t) => {
    const requests = [];
    const sdk = client(t, {
      getAuthToken: () => "secret",
      fetchImpl: async (url, init) => {
        requests.push(init);
        return {
          status:
            c.statuses[Math.min(requests.length - 1, c.statuses.length - 1)],
        };
      },
    });
    await sdk.track(contract.event);
    const r = await sdk.flush();
    assert.equal(r.ok, c.ok);
    assert.equal(requests.length, c.attempts);
    for (const req of requests) {
      assert.equal(req.body, requests[0].body);
      assert.equal(
        req.headers["x-amz-content-sha256"],
        createHash("sha256").update(req.body).digest("hex"),
      );
      assert.equal(req.headers["x-event-auth"], "Bearer secret");
    }
    const event = JSON.parse(requests[0].body).events[0];
    assert.equal(event.name, "checkout_completed");
    assert.equal(event.context.namespace, "claims");
    assert.equal(event.context.sid, contract.event.sid);
    assert.deepEqual(event.properties, contract.properties);
    assert.equal((await sdk.getQueueItems()).length, c.ok ? 0 : 1);
    await sdk.discard([contract.event.event_id]);
  });
test("configuration and input validation", async (t) => {
  for (const endpoint of contract.invalid_endpoints)
    assert.throws(() => createEventingClient({ endpoint }));
  for (const maxRetries of [0, -1, 1.5, 11])
    assert.throws(() =>
      createEventingClient({
        endpoint: "https://example.com/events",
        maxRetries,
      }),
    );
  const c = client(t, { fetchImpl: async () => ({ status: 202 }) });
  for (const name of ["", " ", "x".repeat(129), "a\nb"])
    await assert.rejects(c.track({ name }));
  for (const properties of [[], null, "bad"]) {
    if (properties !== null)
      await assert.rejects(c.track({ name: "x", properties }));
  }
  await assert.rejects(
    c.track({ name: "x", properties: { huge: "a".repeat(9000) } }),
  );
  await c.track({ name: "x", event_id: "id" });
  await assert.rejects(c.track({ name: "x", event_id: "id" }));
});
test("transport errors and timeouts retry unchanged bytes", async (t) => {
  const bodies = [];
  let attempts = 0;
  const c = client(t, {
    timeoutMs: 5,
    fetchImpl: async (_, init) => {
      bodies.push(init.body);
      attempts++;
      if (attempts === 1) throw new Error("offline");
      if (attempts === 2)
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        );
      return { status: 202 };
    },
  });
  await c.track({ name: "x" });
  assert.equal((await c.flush()).ok, true);
  assert.equal(attempts, 3);
  assert.equal(new Set(bodies).size, 1);
});
test("concurrent flush drains byte/count bounded batches once and refreshes tokens per batch", async (t) => {
  const reqs = [];
  let token = 0;
  const c = client(t, {
    maxBatchEvents: 3,
    maxBatchBytes: 800,
    getAuthToken: () => String(++token),
    fetchImpl: async (_, r) => {
      reqs.push(r);
      await pause(2);
      return { status: 202 };
    },
  });
  for (let i = 0; i < 8; i++)
    await c.track({
      name: "x",
      event_id: String(i),
      properties: { text: "é".repeat(60) },
    });
  await Promise.all([c.flush(), c.flush(), c.flush()]);
  const ids = reqs.flatMap((r) =>
    JSON.parse(r.body).events.map((e) => e.event_id),
  );
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
  for (const r of reqs) {
    assert.ok(Buffer.byteLength(r.body) <= 800);
    assert.ok(JSON.parse(r.body).events.length <= 3);
  }
  assert.equal(token, reqs.length);
});
test("durable outage queue survives restart and automatically resumes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "eventing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.json");
  let calls = 0;
  const c = client(t, {
    queue: new NodeFileEventQueue({ path }),
    fetchImpl: async () => {
      calls++;
      return { status: 503 };
    },
  });
  await c.track(contract.event);
  assert.equal((await c.close()).ok, false);
  assert.equal(calls, 3);
  const stored = await readFile(path, "utf8");
  assert.ok(!stored.includes("never-store"));
  const next = client(t, {
    queue: new NodeFileEventQueue({ path }),
    flushIntervalMs: 10,
    fetchImpl: async () => ({ status: 202 }),
  });
  for (let i = 0; i < 50 && (await next.getQueueItems()).length; i++)
    await pause(10);
  assert.equal((await next.getQueueItems()).length, 0);
});
test("automatic recovery after outage; permanent denial stays queued without retry loop", async (t) => {
  let calls = 0,
    online = false;
  const c = client(t, {
    flushIntervalMs: 10,
    maxRetries: 1,
    fetchImpl: async () => {
      calls++;
      return { status: online ? 202 : 503 };
    },
  });
  await c.track({ name: "x" });
  await c.flush();
  online = true;
  for (let i = 0; i < 50 && (await c.getQueueItems()).length; i++)
    await pause(10);
  assert.equal((await c.getQueueItems()).length, 0);
  assert.ok(calls >= 2);
  let denied = 0;
  const d = client(t, {
    flushIntervalMs: 10,
    fetchImpl: async () => {
      denied++;
      return { status: 403 };
    },
  });
  await d.track({ name: "x" });
  await d.flush();
  await pause(35);
  assert.equal(denied, 1);
  assert.equal((await d.getQueueItems()).length, 1);
  await d.discard((await d.getQueueItems()).map((e) => e.event_id));
});
test("automatic size and timer flush, close and bounded queue", async (t) => {
  let sent = 0;
  const c = client(t, {
    maxBatchEvents: 2,
    flushIntervalMs: 15,
    fetchImpl: async () => {
      sent++;
      return { status: 202 };
    },
  });
  await c.track({ name: "a" });
  await c.track({ name: "b" });
  await pause(30);
  assert.equal(sent, 1);
  await c.track({ name: "c" });
  await pause(40);
  assert.equal(sent, 2);
  await c.close();
  await assert.rejects(c.track({ name: "d" }));
  const q = new DurableEventQueue({ maxItems: 1, storage: "memory" });
  await q.bind({ endpoint: "https://example.com/events", environment: "prod", namespace: "general" });
  await q.enqueue({ event_id: "1", name: "x" });
  await assert.rejects(q.enqueue({ event_id: "2", name: "x" }));
  assert.equal((await q.listAll())[0].event_id, "1");
});
test("privacy opt-in never permits credentials; queue snapshots are isolated", async (t) => {
  const c = client(t, {
    allowSensitiveProperties: true,
    fetchImpl: async () => ({ status: 202 }),
  });
  await c.track(contract.event);
  const items = await c.getQueueItems();
  assert.equal(items[0].properties.Email, "private@example.test");
  assert.equal(items[0].properties.nested.TOKEN, undefined);
  items[0].name = "mutated";
  assert.equal((await c.getQueueItems())[0].name, "checkout_completed");
});
test("real HTTP transport posts exact hashes and refuses redirects", async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(
      req.headers["x-amz-content-sha256"],
      createHash("sha256").update(body).digest("hex"),
    );
    res.writeHead(302, { Location: "/secure" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const c = client(t, {
    endpoint: `http://127.0.0.1:${server.address().port}/events`,
    maxRetries: 1,
  });
  await c.track({ name: "x" });
  assert.equal((await c.flush()).ok, false);
  assert.equal(calls, 1);
  await c.discard((await c.getQueueItems()).map((e) => e.event_id));
});
test("browser IndexedDB queue commits, bounds, recovers and removes acknowledged events", async (t) => {
  const { IDBFactory } = await import("fake-indexeddb");
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  t.after(() => {
    globalThis.indexedDB = previous;
  });
  const dbName = `browser-${crypto.randomUUID()}`;
  const q = new DurableEventQueue({ dbName, maxItems: 1 });
  await q.bind({ endpoint: "https://example.com/events", environment: "prod", namespace: "general" });
  await q.enqueue({
    event_id: "1",
    name: "x",
    event_time: "2026-10-19T10:30:00Z",
    context: { namespace: "general" },
    properties: { token: "never-store" },
  });
  assert.ok(!JSON.stringify(await q.listAll()).includes("never-store"));
  await assert.rejects(q.enqueue({ event_id: "2", name: "y" }));
  const reopened = new DurableEventQueue({ dbName, maxItems: 1 });
  await reopened.bind({ endpoint: "https://example.com/events", environment: "prod", namespace: "general" });
  assert.equal((await reopened.listAll()).length, 1);
  const c = client(t, {
    queue: reopened,
    fetchImpl: async () => ({ status: 202 }),
  });
  assert.equal((await c.flush()).flushed, 1);
  assert.equal((await q.listAll()).length, 0);
});
test("max age caps timer and backoff uses exponential delays", async (t) => {
  let calls = 0;
  const c = client(t, {
    flushIntervalMs: 60000,
    maxBatchAgeMs: 10,
    fetchImpl: async () => {
      calls++;
      return { status: 202 };
    },
  });
  await c.track({ name: "x" });
  await pause(40);
  assert.equal(calls, 1);
  let attempts = 0;
  const r = client(t, {
    baseBackoffMs: 10,
    fetchImpl: async () => ({ status: ++attempts < 3 ? 503 : 202 }),
  });
  await r.track({ name: "x" });
  const start = performance.now();
  await r.flush();
  assert.ok(performance.now() - start >= 28);
  assert.equal(attempts, 3);
});
test("storage write failure rejects tracking and auth failure preserves queued events", async (t) => {
  const c = client(t, {
    queue: {
      bind: async () => {},
      listAll: async () => [],
      enqueue: async () => {
        throw new Error("disk full");
      },
      removeBatch: async () => {},
    },
    fetchImpl: async () => ({ status: 202 }),
  });
  await assert.rejects(c.track({ name: "x" }), /disk full/);
  const d = client(t, {
    getAuthToken: () => {
      throw new Error("identity offline");
    },
    fetchImpl: async () => ({ status: 202 }),
  });
  await d.track({ name: "x" });
  await assert.rejects(d.flush(), /identity offline/);
  assert.equal((await d.getQueueItems()).length, 1);
  await d.discard((await d.getQueueItems()).map((e) => e.event_id));
});

test("session IDs are stable, explicit IDs win, and invalid IDs reject", async (t) => {
  const c = client(t, { fetchImpl: async () => ({ status: 503 }) });
  for (const input of contract.session_cases) await c.track(input);
  const items = await c.getQueueItems();
  assert.match(items[0].context.sid, /^[0-9a-f-]{36}$/);
  assert.equal(items[0].context.sid, items[1].context.sid);
  assert.deepEqual(
    items.slice(2).map((e) => e.context.sid),
    ["explicit", "context", "override"],
  );
  const other = client(t, { fetchImpl: async () => ({ status: 202 }) });
  await other.track({ name: "x" });
  assert.notEqual(
    (await other.getQueueItems())[0].context.sid,
    items[0].context.sid,
  );
  for (const sid of contract.invalid_sids) {
    await assert.rejects(c.track({ name: "x", sid }));
    await assert.rejects(c.track({ name: "x", context: { sid } }));
  }
  await c.flush();
  assert.deepEqual(
    (await c.getQueueItems()).map((e) => e.context.sid),
    items.map((e) => e.context.sid),
  );
});

test("producer event IDs are validated before enqueue and survive recovery rounds", async (t) => {
  const requests = [];
  const c = client(t, {
    maxRetries: 1,
    fetchImpl: async (_url, req) => {
      requests.push(req.body);
      return { status: requests.length === 1 ? 503 : 202 };
    },
  });
  for (const event_id of contract.invalid_event_ids)
    await assert.rejects(c.track({ name: "id_test", event_id }));
  assert.equal((await c.getQueueItems()).length, 0);
  for (const event_id of contract.valid_event_ids)
    assert.equal(await c.track({ name: "id_test", event_id }), event_id);
  const input = {
    name: "id_test",
    sid: "request-session-a",
    properties: { value: "original" },
  };
  const generated = await c.track(input);
  input.properties.value = "changed";
  assert.match(generated, /^[0-9a-f-]{36}$/);
  await c.track({ name: "id_test", sid: "request-session-b" });
  await c.track({ name: "id_test" });
  const queued = await c.getQueueItems();
  assert.deepEqual(
    queued.slice(0, 4).map((e) => e.event_id),
    contract.valid_event_ids,
  );
  assert.equal(queued[6].context.sid, queued[0].context.sid);
  assert.equal(queued[4].properties.value, "original");
  assert.equal(queued[4].context.sid, "request-session-a");
  assert.equal(queued[5].context.sid, "request-session-b");
  assert.equal((await c.flush()).ok, false);
  assert.equal((await c.flush()).ok, true);
  const [first, second] = requests.map(JSON.parse);
  assert.deepEqual(first.events, second.events);
  assert.notEqual(first.batch_id, second.batch_id);
});
