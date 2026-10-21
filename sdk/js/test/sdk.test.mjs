import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createEventingClient, DurableEventQueue } from "../src/index.js";

test("SDK emits canonical v1 batch, computes exact SHA-256 hash, and strips default PII/click IDs", async () => {
  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 202 };
  };

  const client = createEventingClient({
    endpoint: "https://events.customer.example/events",
    queue: new DurableEventQueue({ storage: "memory" }),
    defaultNamespace: "claims",
    getAuthToken: async () => "secret-session-jwt-999",
    credentials: "include",
    flushIntervalMs: 5000,
    fetchImpl: mockFetch,
  });

  await client.track({
    name: "claim_document_accessed",
    event_time: "2026-10-19T10:30:00Z",
    properties: {
      claim_id: "CLM98765",
      email: "should-be-stripped-by-default@example.com",
      gclid: "should-be-stripped",
      fbclid: "should-be-stripped",
      token: "should-be-stripped",
    },
  });

  // Verify token is NOT persisted in the durable queue
  const queuedBeforeFlush = await client.getQueueItems();
  assert.equal(queuedBeforeFlush.length, 1);
  const queuedSerialized = JSON.stringify(queuedBeforeFlush);
  assert.ok(!queuedSerialized.includes("secret-session-jwt-999"));
  assert.ok(!queuedSerialized.includes("should-be-stripped"));

  const flushRes = await client.flush();
  assert.equal(flushRes.ok, true);
  assert.equal(flushRes.flushed, 1);
  assert.equal(requests.length, 1);

  const sent = requests[0];
  assert.equal(sent.url, "https://events.customer.example/events");
  assert.equal(sent.init.credentials, "include");
  assert.equal(
    sent.init.headers["x-event-auth"],
    "Bearer secret-session-jwt-999",
  );

  const expectedHash = crypto
    .createHash("sha256")
    .update(Buffer.from(sent.init.body, "utf8"))
    .digest("hex");
  assert.equal(sent.init.headers["x-amz-content-sha256"], expectedHash);

  const parsedBody = JSON.parse(sent.init.body);
  assert.equal(parsedBody.schema_version, "1");
  assert.equal(parsedBody.events.length, 1);
  assert.equal(parsedBody.events[0].name, "claim_document_accessed");
  assert.equal(parsedBody.events[0].context.namespace, "claims");
  assert.equal(parsedBody.events[0].properties.claim_id, "CLM98765");
  assert.equal(parsedBody.events[0].properties.email, undefined);
  assert.equal(parsedBody.events[0].properties.gclid, undefined);

  // Queue is emptied after 202 acknowledgement
  const queuedAfterFlush = await client.getQueueItems();
  assert.equal(queuedAfterFlush.length, 0);
});
