import { queueScope, sameScope } from "./queueScope.js";
import { computePayloadHashHeader } from "./payloadHash.js";
export const CANONICAL_SCHEMA_VERSION = "1";
const forbidden = new Set([
  "email",
  "name",
  "full_name",
  "phone",
  "ssn",
  "source_ip",
  "ip",
  "gclid",
  "fbclid",
  "msclkid",
  "li_fat_id",
  "rdt_cid",
  "oppref",
  "x-event-auth",
  "authorization",
  "token",
]);
const credentials = new Set(["x-event-auth", "authorization", "token"]);
const retryable = new Set([429, 500, 502, 503, 504]);
const uuid = () => globalThis.crypto.randomUUID();
function sanitize(value, allow = false) {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, allow));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !credentials.has(k.toLowerCase()) &&
            (allow || !forbidden.has(k.toLowerCase())),
        )
        .map(([k, v]) => [k, sanitize(v, allow)]),
    );
  return value;
}
export function validateEndpoint(endpoint) {
  const u = new URL(endpoint);
  if (
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    ) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["/events", "/public", "/secure"].includes(u.pathname)
  )
    throw new Error("Invalid public Eventing endpoint");
  return u.href;
}
/** IndexedDB in browsers; bounded memory fallback when IndexedDB cannot be opened.
 * Use a unique dbName per endpoint/tenant. Do not share one queue across live clients.
 */
export class DurableEventQueue {
  constructor({
    dbName = "eventing-durable-queue",
    storeName = "events",
    maxItems = 1000,
    storage = "auto",
  } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1)
      throw new Error("maxItems must be positive");
    Object.assign(this, {
      dbName,
      storeName,
      maxItems,
      storage,
      memoryStore: new Map(),
    });
    this.scope = null;
    this.nodeQueue = null;
    this.db = null;
  }
  async _node() {
    if (this.db) return null;
    if (
      this.storage !== "memory" &&
      !globalThis.indexedDB &&
      globalThis.process?.versions?.node
    ) {
      this.nodeQueue ??= import("./nodeQueue.js").then(
        ({ NodeFileEventQueue }) =>
          new NodeFileEventQueue({
            dbName: this.dbName,
            maxItems: this.maxItems,
          }),
      );
      return this.nodeQueue;
    }
    return null;
  }
  async _openIndexedDb() {
    if (this.storage === "memory") return null;
    if (!this.db)
      this.db = new Promise((resolve) => {
        if (!globalThis.indexedDB) return resolve(null);
        let req;
        try {
          req = globalThis.indexedDB.open(this.dbName, 2);
        } catch {
          return resolve(null);
        }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(this.storeName))
            req.result.createObjectStore(this.storeName, {
              keyPath: "event_id",
            });
          if (!req.result.objectStoreNames.contains("__eventing_scope"))
            req.result.createObjectStore("__eventing_scope");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    return this.db;
  }
  async _checkLegacyIndexedDb() {
    if (this.storage === "memory" || !globalThis.indexedDB) return;
    const db = await new Promise((resolve) => {
      let request;
      try {
        request = globalThis.indexedDB.open(this.dbName);
      } catch {
        return resolve(null);
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
    if (!db) return;
    try {
      if (db.version < 2 && db.objectStoreNames.contains(this.storeName)) {
        const count = await new Promise((resolve, reject) => {
          const transaction = db.transaction(this.storeName, "readonly");
          const request = transaction.objectStore(this.storeName).count();
          transaction.oncomplete = () => resolve(request.result);
          transaction.onerror = transaction.onabort = () =>
            reject(new Error("Queue read failed"));
        });
        if (count)
          throw new Error(
            "Unscoped queue contains events; drain or explicitly migrate it before upgrading",
          );
      }
    } finally {
      db.close();
    }
  }
  async bind(value) {
    const scope = queueScope(value);
    if (this.scope && !sameScope(this.scope, scope))
      throw new Error("Queue scope mismatch");
    const node = await this._node();
    if (node) await node.bind(scope);
    else {
      await this._checkLegacyIndexedDb();
      const db = await this._openIndexedDb();
      if (db)
        await new Promise((resolve, reject) => {
          const tx = db.transaction(
            [this.storeName, "__eventing_scope"],
            "readwrite",
          );
          const metadata = tx.objectStore("__eventing_scope");
          const binding = metadata.get("binding");
          let error;
          const fail = (message) => {
            error = new Error(message);
            tx.abort();
          };
          binding.onsuccess = () => {
            if (binding.result && !sameScope(binding.result, scope))
              return fail("Queue scope mismatch");
            if (!binding.result) {
              const count = tx.objectStore(this.storeName).count();
              count.onsuccess = () => {
                if (count.result)
                  fail(
                    "Unscoped queue contains events; drain or explicitly migrate it before upgrading",
                  );
                else metadata.put(scope, "binding");
              };
            }
          };
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () =>
            reject(error || new Error("Queue scope binding failed"));
        });
      else if (!this.scope && this.memoryStore.size)
        throw new Error("Unscoped queue contains events");
    }
    this.scope = scope;
  }
  async enqueue(event) {
    if (!this.scope)
      throw new Error("Bind the queue to a client scope before use");
    const safe = JSON.parse(
      JSON.stringify(
        sanitize(
          { ...event, properties: sanitize(event.properties, true) },
          true,
        ),
      ),
    );
    safe.queued_at = Date.now();
    const node = await this._node();
    if (node) return node.enqueue(safe);
    const db = await this._openIndexedDb();
    if (!db) {
      if (this.memoryStore.has(safe.event_id))
        throw new Error("Duplicate queued event ID");
      if (this.memoryStore.size >= this.maxItems)
        throw new Error("Event queue is full");
      this.memoryStore.set(safe.event_id, safe);
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite"),
        store = tx.objectStore(this.storeName);
      const count = store.count();
      count.onsuccess = () => {
        const exists = store.get(safe.event_id);
        exists.onsuccess = () => {
          if (exists.result || count.result >= this.maxItems) tx.abort();
          else store.put(safe);
        };
      };
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () =>
        reject(new Error("Queue write failed or queue is full"));
    });
  }
  async listAll() {
    if (!this.scope)
      throw new Error("Bind the queue to a client scope before use");
    const node = await this._node();
    if (node) return node.listAll();
    const db = await this._openIndexedDb();
    if (!db) return structuredClone([...this.memoryStore.values()]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly"),
        req = tx.objectStore(this.storeName).getAll();
      tx.oncomplete = () =>
        resolve((req.result || []).sort((a, b) => a.queued_at - b.queued_at));
      tx.onerror = tx.onabort = () => reject(new Error("Queue read failed"));
    });
  }
  async removeBatch(ids) {
    if (!this.scope)
      throw new Error("Bind the queue to a client scope before use");
    const node = await this._node();
    if (node) return node.removeBatch(ids);
    const db = await this._openIndexedDb();
    if (!db) {
      ids.forEach((id) => this.memoryStore.delete(id));
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite"),
        store = tx.objectStore(this.storeName);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new Error("Queue removal failed"));
    });
  }
}
export function createEventingClient({
  endpoint,
  environment = "prod",
  defaultNamespace = "general",
  getAuthToken = null,
  credentials = "omit",
  maxBatchEvents = 25,
  flushIntervalMs = 1000,
  maxBatchAgeMs = 5000,
  maxRetries = 3,
  baseBackoffMs = 200,
  timeoutMs = 5000,
  maxBatchBytes = 8192,
  maxQueueItems = 1000,
  allowSensitiveProperties = false,
  fetchImpl = globalThis.fetch,
  queue = null,
  onError = () => {},
} = {}) {
  endpoint = validateEndpoint(endpoint);
  const scope = queueScope({
    endpoint,
    environment,
    namespace: defaultNamespace,
  });
  for (const [k, v] of Object.entries({
    maxBatchEvents,
    maxRetries,
    timeoutMs,
    maxBatchBytes,
    maxQueueItems,
    flushIntervalMs,
    maxBatchAgeMs,
  }))
    if (!Number.isInteger(v) || v < 1)
      throw new Error(`${k} must be a positive integer`);
  if (
    maxBatchEvents > 500 ||
    maxRetries > 10 ||
    !Number.isFinite(baseBackoffMs) ||
    baseBackoffMs < 0 ||
    typeof fetchImpl !== "function" ||
    !defaultNamespace.trim()
  )
    throw new Error("Invalid client configuration");
  queue ??= new DurableEventQueue({
    dbName: `eventing:${environment === "prod" ? "" : environment + ":"}${endpoint}:${defaultNamespace}`,
    maxItems: maxQueueItems,
  });
  if (typeof queue.bind !== "function")
    throw new Error("Custom queues must implement persistent bind(scope)");
  const ready = queue.bind(scope);
  const clientSid = uuid();
  let timer = null,
    started = null,
    inFlight = null,
    closed = false;
  function recover() {
    if (!closed) {
      clearTimeout(timer);
      timer = setTimeout(backgroundFlush, flushIntervalMs);
      timer.unref?.();
    }
  }
  const envelope = (events, batch_id = uuid()) => ({
    schema_version: "1",
    batch_id,
    events: events.map(({ queued_at, ...e }) => e),
  });
  const fits = (events) =>
    new TextEncoder().encode(JSON.stringify(envelope(events))).length <=
    maxBatchBytes;
  async function send(events) {
    const body = JSON.stringify(envelope(events));
    const { hashHex } = await computePayloadHashHeader(body);
    const headers = {
      "Content-Type": "application/json",
      "x-amz-content-sha256": hashHex,
    };
    const token = await getAuthToken?.();
    if (token) {
      if (typeof token !== "string" || /[\x00-\x1f\x7f]/.test(token))
        throw new Error("Invalid auth token");
      if (token.trim())
        headers["x-event-auth"] = token.trim().startsWith("Bearer ")
          ? token.trim()
          : `Bearer ${token.trim()}`;
    }
    let status = 503;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body,
          credentials,
          redirect: "manual",
          signal: controller.signal,
          keepalive: true,
        });
        status = res.status;
        await res.body?.cancel();
      } catch {
        status = 503;
      } finally {
        clearTimeout(timeout);
      }
      if (status === 202 || !retryable.has(status)) break;
      if (attempt + 1 < maxRetries && baseBackoffMs)
        await new Promise((r) => setTimeout(r, baseBackoffMs * 2 ** attempt));
    }
    return { ok: status === 202, status, retryable: retryable.has(status) };
  }
  async function drain() {
    await ready;
    let flushed = 0;
    while (true) {
      const items = await queue.listAll();
      if (!items.length) return { ok: true, flushed };
      const batch = [];
      for (const item of items.slice(0, maxBatchEvents)) {
        if (!fits([...batch, item])) break;
        batch.push(item);
      }
      if (!batch.length) throw new Error("Queued event exceeds maxBatchBytes");
      const result = await send(batch);
      if (!result.ok) {
        if (result.retryable) recover();
        return { ...result, flushed };
      }
      await queue.removeBatch(batch.map((e) => e.event_id));
      flushed += batch.length;
    }
  }
  async function flush() {
    await ready;
    clearTimeout(timer);
    timer = null;
    started = null;
    if (!inFlight)
      inFlight = drain()
        .catch((e) => {
          recover();
          throw e;
        })
        .finally(() => {
          inFlight = null;
        });
    return inFlight;
  }
  function backgroundFlush() {
    void flush().then(
      (r) => {
        if (!r.ok) {
          try {
            onError(r);
          } catch {}
        }
      },
      (e) => {
        recover();
        try {
          onError(e);
        } catch {}
      },
    );
  }
  async function track(input) {
    await ready;
    if (closed) throw new Error("Client is closed");
    if (
      !input ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      new TextEncoder().encode(input.name.trim()).length > 128 ||
      /[\x00-\x1f\x7f]/.test(input.name)
    )
      throw new Error(
        "Event name must be non-empty and at most 128 UTF-8 bytes",
      );
    const namespace =
      input.namespace ?? input.context?.namespace ?? defaultNamespace;
    if (typeof namespace !== "string" || !namespace.trim())
      throw new Error("namespace must be non-empty");
    const sid = Object.hasOwn(input, "sid")
      ? input.sid
      : Object.hasOwn(input.context ?? {}, "sid")
        ? input.context.sid
        : clientSid;
    if (
      typeof sid !== "string" ||
      !sid.trim() ||
      new TextEncoder().encode(sid).length > 256 ||
      /[\x00-\x1f\x7f]/.test(sid)
    )
      throw new Error(
        "sid must be a non-empty string of at most 256 UTF-8 bytes",
      );
    const props = input.properties ?? input.props ?? {};
    if (!props || typeof props !== "object" || Array.isArray(props))
      throw new Error("properties must be an object");
    const event = JSON.parse(
      JSON.stringify({
        event_id: input.event_id === undefined ? uuid() : input.event_id,
        name: input.name.trim(),
        event_time: input.event_time ?? new Date().toISOString(),
        context: { namespace, sid },
        properties: sanitize(props, allowSensitiveProperties),
      }),
    );
    if (
      typeof event.event_id !== "string" ||
      !event.event_id ||
      new TextEncoder().encode(event.event_id).length > 128 ||
      event.event_id.trim() !== event.event_id ||
      /[\x00-\x1f\x7f-\x9f]/.test(event.event_id) ||
      typeof event.event_time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        event.event_time,
      ) ||
      !Number.isFinite(Date.parse(event.event_time))
    )
      throw new Error("Invalid event ID or time");
    if (!fits([event])) throw new Error("Event exceeds maxBatchBytes");
    if ((await queue.listAll()).some((e) => e.event_id === event.event_id))
      throw new Error("Duplicate queued event ID");
    await queue.enqueue(event);
    started ??= Date.now();
    if ((await queue.listAll()).length >= maxBatchEvents) backgroundFlush();
    else if (!timer)
      timer = setTimeout(
        backgroundFlush,
        Math.min(
          flushIntervalMs,
          Math.max(0, maxBatchAgeMs - (Date.now() - started)),
        ),
      );
    return event.event_id;
  }
  // Recover previously persisted events even when no new track call is made.
  void ready
    .then(() => queue.listAll())
    .then((items) => {
      if (items.length && !closed && !timer) {
        timer = setTimeout(
          backgroundFlush,
          Math.min(flushIntervalMs, maxBatchAgeMs),
        );
        timer.unref?.();
      }
    })
    .catch((e) => {
      try {
        onError(e);
      } catch {}
    });
  return {
    track,
    flush,
    getQueueItems: async () => {
      await ready;
      return queue.listAll();
    },
    discard: async (ids) => {
      await ready;
      return queue.removeBatch(ids);
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      return flush();
    },
  };
}
