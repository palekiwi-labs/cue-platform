import { randomUUID } from "node:crypto"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createNatsClient, type NatsClient, type NatsClientOptions } from "./client"
import { parseStoreEvent, type StoreEvent, storeSubject } from "./store-events"

/** Payload of the `cue:task-set` pi event emitted by setSessionTask. */
export interface TaskSetData {
  address: string
  sessionId?: string
  reason?: string
}

/**
 * Build the `task_set` store event for a session's active-task set: the
 * task's address on its context's subject, with `scope: "session"` and
 * the setting session named, so subscribers read a session's focus
 * rather than a claim.
 */
export function buildTaskSetEvent(
  data: TaskSetData,
  now = new Date(),
  id: string = randomUUID(),
): StoreEvent {
  return {
    v: 1,
    event: "task_set",
    event_id: id,
    address: data.address,
    occurred_at: now.toISOString(),
    context: data.address.split("/").slice(0, 3).join("/"),
    type: "task",
    title: null,
    origin_session: data.sessionId ?? null,
    parent_event_id: null,
    root_event_id: id,
    depth: 0,
    scope: "session",
    session_id: data.sessionId,
    reason: data.reason === "session_birth" ? "session_birth" : "selection",
  }
}

/** A built task_set event as it crossed the pi event bus, or undefined. */
export function parseTaskSetEvent(data: unknown): StoreEvent | undefined {
  if (!data || typeof data !== "object") return undefined
  return parseStoreEvent(data, (data as StoreEvent).context)
}

/**
 * Publish `task_set` events on the cue.evt.v1 subject family: one
 * fire-and-forget connection, plus a `cue:task-set-queued` pi event so
 * the setting session's own subscriptions module can enqueue the same
 * line locally (deduped against the NATS echo by event_id).
 */
export function registerTaskSetPublisher(
  pi: ExtensionAPI,
  factory: (options: NatsClientOptions) => NatsClient = createNatsClient,
): void {
  const client = factory({ name: "pi task-set publisher" })
  client.start()
  pi.events.on("cue:task-set", (data: unknown) => {
    const event = parseTaskSetEvent(buildTaskSetEvent(data as TaskSetData))
    if (!event) return
    client.publish(storeSubject(event.context, "task_set"), event)
    pi.events.emit("cue:task-set-queued", event)
  })
  pi.on("session_shutdown", () => void client.close())
}
