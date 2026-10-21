import {
  createEventingClient,
  DurableEventQueue,
  type EventInput,
} from "../src/index.js";
import { NodeFileEventQueue } from "../src/nodeQueue.js";
import { computePayloadHashHeader } from "../src/payloadHash.js";
const event: EventInput = {
  name: "x",
  sid: "app-session",
  context: { sid: "fallback-session" },
  properties: { count: 1 },
};
const client = createEventingClient({
  endpoint: "https://example.com/events",
  queue: new DurableEventQueue({ storage: "memory" }),
  getAuthToken: async () => undefined,
});
void client.track(event);
void client.flush();
void client.close();
const queue = new NodeFileEventQueue({ path: "/tmp/eventing-types.json" });
void queue.listAll();
void computePayloadHashHeader("{}");
// @ts-expect-error name is required
void client.track({ properties: {} });

// @ts-expect-error sid must be a string
void client.track({ name: "x", sid: 1 });
