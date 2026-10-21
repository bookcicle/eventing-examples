export interface EventInput {
  name: string;
  namespace?: string;
  /** Per-event non-secret session override; does not change the client default. */
  sid?: string;
  /** Opaque 1–128 UTF-8 byte ID; generated once before enqueue when omitted. */
  event_id?: string;
  event_time?: string;
  context?: { namespace?: string; sid?: string };
  properties?: Record<string, unknown>;
  props?: Record<string, unknown>;
}
export interface CanonicalEvent {
  event_id: string;
  name: string;
  event_time: string;
  context: { namespace: string; sid?: string };
  properties: Record<string, unknown>;
  queued_at?: number;
}
export interface QueueScope {
  endpoint: string;
  environment: "dev" | "test" | "prod";
  namespace: string;
}
export interface EventQueue {
  bind(scope: QueueScope): Promise<void>;
  enqueue(event: CanonicalEvent): Promise<void>;
  listAll(): Promise<CanonicalEvent[]>;
  removeBatch(ids: string[]): Promise<void>;
}
export interface FlushResult {
  ok: boolean;
  flushed: number;
  status?: number;
  retryable?: boolean;
}
export interface ClientOptions {
  endpoint: string;
  environment?: "dev" | "test" | "prod";
  defaultNamespace?: string;
  getAuthToken?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  credentials?: RequestCredentials;
  maxBatchEvents?: number;
  flushIntervalMs?: number;
  maxBatchAgeMs?: number;
  maxQueueItems?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
  maxBatchBytes?: number;
  allowSensitiveProperties?: boolean;
  fetchImpl?: typeof fetch;
  queue?: EventQueue;
  onError?: (error: unknown) => void;
}
export const CANONICAL_SCHEMA_VERSION: "1";
export function validateEndpoint(endpoint: string): string;
export class DurableEventQueue implements EventQueue {
  constructor(options?: {
    dbName?: string;
    storeName?: string;
    maxItems?: number;
    storage?: "auto" | "memory";
  });
  bind(scope: QueueScope): Promise<void>;
  enqueue(event: CanonicalEvent): Promise<void>;
  listAll(): Promise<CanonicalEvent[]>;
  removeBatch(ids: string[]): Promise<void>;
}
export function createEventingClient(options: ClientOptions): {
  track(input: EventInput): Promise<string>;
  flush(): Promise<FlushResult>;
  close(): Promise<FlushResult>;
  getQueueItems(): Promise<CanonicalEvent[]>;
  discard(ids: string[]): Promise<void>;
};
