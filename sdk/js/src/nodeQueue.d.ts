import type { EventQueue, CanonicalEvent, QueueScope } from "./index.js";
export class NodeFileEventQueue implements EventQueue {
  constructor(options?: { path?: string; dbName?: string; maxItems?: number });
  bind(scope: QueueScope): Promise<void>;
  enqueue(event: CanonicalEvent): Promise<void>;
  listAll(): Promise<CanonicalEvent[]>;
  removeBatch(ids: string[]): Promise<void>;
}
