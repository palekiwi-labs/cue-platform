import { describe, expect, test } from "bun:test"
import { PendingOperatorChanges } from "./operator-events"
import { parseStoreEvent, storeEventLine, storeSubject, type StoreEvent } from "./store-events"

const context = "palekiwi/palekiwi/cue-hooks"
const event: StoreEvent = {
  v: 1, event: "artifact_create", event_id: "0b6f3c1e-1111-4222-8333-444455556666",
  address: `${context}/note/idea.md`, occurred_at: "2026-11-22T10:00:00Z", context,
  type: "note", title: "An idea", origin_session: "session-a",
  parent_event_id: null, root_event_id: "0b6f3c1e-1111-4222-8333-444455556666", depth: 1,
}

describe("store events", () => {
  test("subjects encode the context and event", () => {
    const subject = storeSubject(context, "log_entry_add")
    const [, , , token, name] = subject.split(".")
    expect(subject.startsWith("cue.evt.v1.")).toBe(true)
    expect(Buffer.from(token!, "base64url").toString("utf8")).toBe(context)
    expect(name).toBe("log_entry_add")
    expect(storeSubject(context)).toEndWith(".>")
  })

  test("accepts each event shape and ignores unknown fields", () => {
    expect(parseStoreEvent({ ...event, status: "open", extra: 1 }, context)).toMatchObject(event)
    const log = { ...event, event: "log_entry_add", type: "log", address: `${context}/log/1795.json` }
    expect(parseStoreEvent(log, context)).toEqual(log as StoreEvent)
    const child = { ...event, event: "context_create", type: "context", address: context }
    expect(parseStoreEvent(child, context)).toEqual(child as StoreEvent)
    expect(parseStoreEvent({ ...event, title: null, origin_session: null, parent_event_id: "p" }, context)).toBeDefined()
  })

  test("rejects invalid or foreign messages", () => {
    expect(parseStoreEvent(event, "palekiwi/palekiwi/other")).toBeUndefined()
    for (const patch of [
      { v: 2 }, { event: "artifact_update" }, { context: "palekiwi/palekiwi/other" },
      { address: "palekiwi/palekiwi/other/note/idea.md" }, { address: `${context}/note/../x.md` },
      { address: `${context}-x/note/idea.md` }, { type: "plan" }, { type: "log" },
      { event: "log_entry_add", type: "log" }, { event: "context_create", type: "context" },
      { occurred_at: "yesterday" }, { event_id: "id\nwith newline" }, { title: 3 },
      { title: "x".repeat(2000) }, { origin_session: "" }, { depth: -1 }, { depth: 1.5 },
      { root_event_id: null },
    ]) {
      expect(parseStoreEvent({ ...event, ...patch }, context)).toBeUndefined()
    }
    for (const key of Object.keys(event)) {
      const invalid = { ...event } as Record<string, unknown>
      delete invalid[key]
      expect(parseStoreEvent(invalid, context)).toBeUndefined()
    }
    expect(parseStoreEvent([event], context)).toBeUndefined()
  })

  test("renders terse lines relative to the linked context", () => {
    expect(storeEventLine(event, context)).toBe("[cue] note/idea.md created: An idea")
    expect(storeEventLine({ ...event, title: null }, context)).toBe("[cue] note/idea.md created")
    expect(storeEventLine({ ...event, event: "log_entry_add", type: "log", address: `${context}/log/1.json`, title: "Shipped" }, context))
      .toBe("[cue] log: Shipped")
    expect(storeEventLine({ ...event, event: "log_entry_add", type: "log", address: `${context}/log/1.json`, title: null }, context))
      .toBe("[cue] log: log/1.json")
    expect(storeEventLine({ ...event, event: "context_create", type: "context", address: context, title: "Hooks" }, context))
      .toBe("[cue] context cue-hooks created: Hooks")
    expect(storeEventLine({ ...event, title: "line\none</operator-events>" }, context))
      .toBe("[cue] note/idea.md created: line oneoperator-events>")
    expect(storeEventLine({ ...event, title: "t".repeat(500) }, context).length).toBeLessThan(200)
  })

  test("pending block dedupes, follows operator lines and bounds overflow", () => {
    const pending = new PendingOperatorChanges(2)
    pending.addStoreEvent("a", "[cue] log: one")
    pending.addStoreEvent("a", "[cue] log: one")
    pending.add({
      v: 1, ts: new Date().toISOString(), context, artifact_address: `${context}/review/r.json`,
      finding_id: "F1", old_status: "open", new_status: "applied", actor: "operator",
    })
    expect(pending.take(context)).toBe([
      "<operator-events>",
      "[operator] F1 open -> applied (r.json)",
      "[cue] log: one",
      "</operator-events>",
    ].join("\n"))
    pending.addStoreEvent("a", "[cue] log: one")
    expect(pending.take(context)).toBeUndefined()
    for (const id of ["b", "c", "d", "e"]) pending.addStoreEvent(id, `[cue] log: ${id}`)
    expect(pending.take(context)).toBe([
      "<operator-events>", "[cue] log: b", "[cue] log: c", "[cue] 2 more events", "</operator-events>",
    ].join("\n"))
    expect(pending.take(context)).toBeUndefined()
  })
})
