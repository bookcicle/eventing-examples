import { computePayloadHashHeader } from "./payloadHash.js";

export const CANONICAL_SCHEMA_VERSION = "1";
const DEFAULT_MAX_BATCH_EVENTS = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH_AGE_MS = 5000;
const DEFAULT_MAX_QUEUE_ITEMS = 1000;
const DEFAULT_QUEUE_DB_NAME = "eventing-durable-queue";
const DEFAULT_QUEUE_STORE_NAME = "events";

const FORBIDDEN_DEFAULT_PII_KEYS = new Set([
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

function generateUuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Durable queue adapter supporting IndexedDB in browsers with automatic fallback
 * to a bounded in-memory Map in Node/SSR/restricted environments.
 */
export class DurableEventQueue {
  constructor({
    dbName = DEFAULT_QUEUE_DB_NAME,
    storeName = DEFAULT_QUEUE_STORE_NAME,
    maxItems = DEFAULT_MAX_QUEUE_ITEMS,
  } = {}) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.maxItems = maxItems;
    this.memoryStore = new Map();
  }

  async _openIndexedDb() {
    const idb = globalThis.indexedDB;
    if (!idb) return null;
    return new Promise((resolve, reject) => {
      const req = idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "event_id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async enqueue(eventItem) {
    // Safety invariant: never persist auth tokens or credentials in durable queue
    const safeClone = {
      event_id: eventItem.event_id,
      name: eventItem.name,
      event_time: eventItem.event_time,
      context: { ...(eventItem.context || {}) },
      properties: { ...(eventItem.properties || {}) },
      queued_at: Date.now(),
    };
    delete safeClone.context["x-event-auth"];
    delete safeClone.context.token;
    delete safeClone.properties["x-event-auth"];

    const db = await this._openIndexedDb().catch(() => null);
    if (!db) {
      if (this.memoryStore.size >= this.maxItems) {
        const oldestKey = this.memoryStore.keys().next().value;
        if (oldestKey) this.memoryStore.delete(oldestKey);
      }
      this.memoryStore.set(safeClone.event_id, safeClone);
      return;
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.put(safeClone);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async removeBatch(eventIds) {
    const db = await this._openIndexedDb().catch(() => null);
    if (!db) {
      for (const id of eventIds) {
        this.memoryStore.delete(id);
      }
      return;
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      for (const id of eventIds) {
        store.delete(id);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async listAll() {
    const db = await this._openIndexedDb().catch(() => null);
    if (!db) {
      return Array.from(this.memoryStore.values());
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result || []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }
}

/**
 * Creates a standalone, privacy-safe Eventing by Bookcicle client.
 * - Does NOT collect user email, name, IP, or ad click IDs by default.
 * - Emits canonical v1 batches (`schema_version: "1"`, `batch_id`, `events`).
 * - Computes `x-amz-content-sha256` over the exact UTF-8 request body bytes.
 * - Calls `getAuthToken()` per batch flush and attaches `x-event-auth` without storing tokens in the queue.
 */
export function createEventingClient({
  endpoint,
  defaultNamespace = "general",
  getAuthToken = null,
  credentials = "omit",
  maxBatchEvents = DEFAULT_MAX_BATCH_EVENTS,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxBatchAgeMs = DEFAULT_MAX_BATCH_AGE_MS,
  maxRetries = 3,
  baseBackoffMs = 200,
  allowSensitiveProperties = false,
  fetchImpl = globalThis.fetch,
  queue = new DurableEventQueue(),
} = {}) {
  if (!endpoint || typeof endpoint !== "string") {
    throw new Error("createEventingClient requires a valid 'endpoint' URL string");
  }

  let pending = [];
  let batchStartedAt = null;
  let flushTimer = null;

  function sanitizeProperties(props = {}) {
    const out = {};
    for (const [k, v] of Object.entries(props)) {
      const lower = k.toLowerCase();
      if (!allowSensitiveProperties && FORBIDDEN_DEFAULT_PII_KEYS.has(lower)) {
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  function buildCanonicalEvent(input) {
    if (!input || typeof input.name !== "string" || !input.name.trim()) {
      throw new Error("Event 'name' is required and must be a non-empty string");
    }

    const namespace =
      input.namespace ||
      input.context?.namespace ||
      defaultNamespace;

    return {
      event_id: input.event_id || generateUuid(),
      name: input.name.trim(),
      event_time: input.event_time || new Date().toISOString(),
      context: {
        namespace,
      },
      properties: sanitizeProperties(input.properties || input.props || {}),
    };
  }

  async function sendBatchRequest(events) {
    const envelope = {
      schema_version: CANONICAL_SCHEMA_VERSION,
      batch_id: generateUuid(),
      events: events.map((ev) => ({
        event_id: ev.event_id,
        name: ev.name,
        event_time: ev.event_time,
        context: ev.context,
        properties: ev.properties,
      })),
    };

    const serializedBody = JSON.stringify(envelope);
    const { hashHex } = await computePayloadHashHeader(serializedBody);

    const headers = {
      "Content-Type": "application/json",
      "x-amz-content-sha256": hashHex,
    };

    if (typeof getAuthToken === "function") {
      const token = await getAuthToken();
      if (token && typeof token === "string" && token.trim()) {
        headers["x-event-auth"] = token.trim().startsWith("Bearer ")
          ? token.trim()
          : `Bearer ${token.trim()}`;
      }
    }

    let attempt = 0;
    while (attempt < maxRetries) {
      attempt += 1;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: serializedBody,
        credentials,
        keepalive: true,
      });

      if (response.ok || response.status === 202) {
        return {
          ok: true,
          status: response.status,
          batch_id: envelope.batch_id,
          hashHex,
          serializedBody,
        };
      }

      // Do not retry 4xx client/auth denials (fail closed)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return {
          ok: false,
          status: response.status,
          batch_id: envelope.batch_id,
          retryable: false,
        };
      }

      if (attempt < maxRetries && baseBackoffMs > 0) {
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return {
      ok: false,
      status: 503,
      batch_id: envelope.batch_id,
      retryable: true,
    };
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const batch = pending.splice(0, maxBatchEvents);
    batchStartedAt = pending.length ? Date.now() : null;
    if (batch.length === 0) {
      return { flushed: 0, ok: true };
    }

    const result = await sendBatchRequest(batch);
    if (result.ok || result.retryable === false) {
      await queue.removeBatch(batch.map((e) => e.event_id));
    }

    return {
      flushed: result.ok ? batch.length : 0,
      ...result,
    };
  }

  function scheduleFlush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (pending.length >= maxBatchEvents) {
      void flush();
      return;
    }

    const age = batchStartedAt == null ? 0 : Date.now() - batchStartedAt;
    const remaining = Math.max(0, maxBatchAgeMs - age);
    const delay = Math.min(flushIntervalMs, remaining);

    flushTimer = setTimeout(() => {
      void flush();
    }, delay);
  }

  async function track(eventInput) {
    const normalized = buildCanonicalEvent(eventInput);
    await queue.enqueue(normalized);
    if (pending.length === 0) {
      batchStartedAt = Date.now();
    }
    pending.push(normalized);
    scheduleFlush();
    return normalized.event_id;
  }

  return {
    track,
    flush,
    getQueueItems: () => queue.listAll(),
  };
}
