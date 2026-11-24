import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { buildTaskSetEvent, parseTaskSetEvent, registerTaskSetPublisher } from "./task-events"
import { storeSubject } from "./store-events"

describe("buildTaskSetEvent", () => {
  test("fills the session-focus payload", () => {
    const e = buildTaskSetEvent(
      { address: "o/r/c/task/t.md", sessionId: "s1", reason: "session_birth" },
      new Date("2026-01-01T00:00:00Z"),
      "id1",
    )
    expect(e).toMatchObject({
      v: 1, event: "task_set", event_id: "id1", address: "o/r/c/task/t.md",
      occurred_at: "2026-01-01T00:00:00.000Z", context: "o/r/c", type: "task", title: null,
      origin_session: "s1", parent_event_id: null, root_event_id: "id1", depth: 0,
      scope: "session", session_id: "s1", reason: "session_birth",
    })
    expect(parseTaskSetEvent(e)).toBeDefined()
  })

  test("an unknown reason falls back to selection; session id is optional", () => {
    const e = buildTaskSetEvent({ address: "o/r/c/task/t.md" })
    expect(e.reason).toBe("selection")
    expect(e.session_id).toBeUndefined()
  })
})

describe("registerTaskSetPublisher", () => {
  test("publishes to the task's context subject and re-emits for the local queue", () => {
    const handlers = new Map<string, (data: unknown) => void>()
    const emitted: [string, unknown][] = []
    const started: boolean[] = []
    const publishes: { subject: string; data: unknown }[] = []
    const pi = {
      on: (name: string, fn: (data: unknown) => void) => handlers.set(name, fn),
      events: {
        on: (name: string, fn: (data: unknown) => void) => {
          handlers.set(`event:${name}`, fn)
          return () => handlers.delete(`event:${name}`)
        },
        emit: (name: string, data: unknown) => {
          emitted.push([name, data])
          handlers.get(`event:${name}`)?.(data)
        },
      },
    } as unknown as ExtensionAPI
    registerTaskSetPublisher(
      pi,
      () => ({
        start: () => { started.push(true) },
        publish: (subject: string, data: unknown) => { publishes.push({ subject, data }); return true },
        close: async () => {},
        state: () => "idle",
      }) as never,
    )
    expect(started).toHaveLength(1)
    pi.events.emit("cue:task-set", { address: "o/r/c/task/t.md", sessionId: "s1", reason: "selection" })
    expect(publishes).toHaveLength(1)
    expect(publishes[0]!.subject).toBe(storeSubject("o/r/c", "task_set"))
    expect((publishes[0]!.data as { session_id: string }).session_id).toBe("s1")
    const queued = emitted.find(([n]) => n === "cue:task-set-queued")
    expect(queued).toBeDefined()
    expect(parseTaskSetEvent(queued![1])).toMatchObject({ event: "task_set", address: "o/r/c/task/t.md" })
  })
})
