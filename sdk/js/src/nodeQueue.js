import { queueScope, sameScope, scopedEvents } from "./queueScope.js";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
/** Atomic file queue for Node. One live client per queue path. */
export class NodeFileEventQueue {
  constructor({
    path,
    dbName = "eventing-durable-queue",
    maxItems = 1000,
  } = {}) {
    this.path =
      path ??
      join(
        homedir(),
        ".cache/bookcicle/eventing/js",
        createHash("sha256")
          .update(dbName.replace(/^eventing:/, ""))
          .digest("hex") + ".json",
      );
    this.maxItems = maxItems;
    this.serial = Promise.resolve();
    this.scope = null;
  }
  bind(value) {
    const scope = queueScope(value);
    return this._run(async () => {
      if (this.scope && !sameScope(this.scope, scope))
        throw new Error("Queue scope mismatch");
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(
          this.path,
          JSON.stringify({ version: 2, scope, events: [] }),
          { flag: "wx", mode: 0o600, flush: true },
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const data = JSON.parse(await readFile(this.path, "utf8"));
      const events = scopedEvents(data, scope, this.maxItems);
      this.scope = scope;
      if (Array.isArray(data)) await this._write(events);
    });
  }
  async _read() {
    if (!this.scope)
      throw new Error("Bind the queue to a client scope before use");
    return scopedEvents(
      JSON.parse(await readFile(this.path, "utf8")),
      this.scope,
      this.maxItems,
    );
  }
  _run(fn) {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => {});
    return next;
  }
  async _write(items) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temp,
        JSON.stringify({ version: 2, scope: this.scope, events: items }),
        {
          mode: 0o600,
          flush: true,
        },
      );
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  enqueue(event) {
    return this._run(async () => {
      const items = await this._read();
      if (items.length >= this.maxItems) throw new Error("Event queue is full");
      if (items.some((e) => e.event_id === event.event_id))
        throw new Error("Duplicate queued event ID");
      items.push({ ...event, queued_at: Date.now() });
      await this._write(items);
    });
  }
  listAll() {
    return this._run(() => this._read());
  }
  removeBatch(ids) {
    return this._run(async () =>
      this._write(
        (await this._read()).filter((e) => !ids.includes(e.event_id)),
      ),
    );
  }
}
