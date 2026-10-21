export function queueScope({ endpoint, environment, namespace }) {
  if (
    !["dev", "test", "prod"].includes(environment) ||
    typeof endpoint !== "string" ||
    typeof namespace !== "string"
  )
    throw new Error("Invalid queue scope");
  return Object.freeze({ endpoint, environment, namespace });
}
export function sameScope(a, b) {
  return (
    a?.endpoint === b.endpoint &&
    a?.environment === b.environment &&
    a?.namespace === b.namespace
  );
}
export function scopedEvents(data, scope, maxItems) {
  if (Array.isArray(data)) {
    if (data.length)
      throw new Error(
        "Unscoped queue contains events; drain or explicitly migrate it before upgrading",
      );
    return [];
  }
  if (data?.version !== 2 || !sameScope(data.scope, scope))
    throw new Error("Queue endpoint/environment/namespace scope mismatch");
  if (!Array.isArray(data.events) || data.events.length > maxItems)
    throw new Error("Invalid persisted queue");
  return data.events;
}
