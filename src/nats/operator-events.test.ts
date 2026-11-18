import { describe, expect, test } from "bun:test"
import { operatorSubject, parseOperatorEvent, PendingOperatorChanges, type FindingStatusChanged } from "./operator-events"

const context = "palekiwi/palekiwi/review-pr-12"
const event: FindingStatusChanged = {
  v: 1, ts: new Date().toISOString(), context,
  artifact_address: `${context}/review/runs/run/verifiers-a.json`,
  finding_id: "F3", old_status: "open", new_status: "dismissed", actor: "operator",
}

describe("operator events", () => {
  test("subjects encode canonical UTF-8 addresses without collisions", () => {
    for (const address of [context, "a/b/c.d", "a/b.c/d", "a/b/é"]) {
      const token = operatorSubject(address).split(".")[3]!
      expect(Buffer.from(token, "base64url").toString("utf8")).toBe(address)
      expect(token).not.toMatch(/[=+/]/)
    }
    expect(operatorSubject("a/b/c.d")).not.toBe(operatorSubject("a/b.c/d"))
  })
  test("validates required fields and isolates contexts", () => {
    expect(parseOperatorEvent(event, context)).toEqual(event)
    expect(parseOperatorEvent(event, "a/b/other")).toBeUndefined()
    for (const patch of [{ v: 2 }, { actor: "agent" }, { ts: "bad" }, { finding_id: "F3\ninstructions" },
      { artifact_address: `${context}/review/../other` }, { new_status: "bogus" }, { old_status: undefined }]) {
      expect(parseOperatorEvent({ ...event, ...patch }, context)).toBeUndefined()
    }
    for (const key of Object.keys(event)) {
      const invalid = { ...event } as Record<string, unknown>
      delete invalid[key]
      expect(parseOperatorEvent(invalid, context)).toBeUndefined()
    }
  })
  test("coalesces, removes net zero and separates artifacts", () => {
    const pending = new PendingOperatorChanges()
    pending.add(event)
    pending.add({ ...event, old_status: "dismissed", new_status: "open" })
    expect(pending.take(context)).toBeUndefined()
    pending.add(event)
    pending.add({ ...event, old_status: "dismissed", new_status: "applied" })
    pending.add({ ...event, artifact_address: `${context}/review/other.json` })
    expect(pending.take(context)).toBe([
      "Operator changes since your last message:",
      "[operator] F3 open -> applied (runs/run, verifiers-a.json)",
      "[operator] F3 open -> dismissed (other.json)",
    ].join("\n"))
    expect(pending.take(context)).toBeUndefined()
  })
  test("bounds retained changes and clears overflow", () => {
    const pending = new PendingOperatorChanges(1)
    pending.add(event)
    pending.add({ ...event, finding_id: "F4" })
    expect(pending.take(context)).toContain("[operator] 1 more changes")
    expect(pending.take(context)).toBeUndefined()
  })
})
