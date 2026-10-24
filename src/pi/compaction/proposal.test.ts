import { describe, expect, test } from "bun:test"
import { parseProposal, type ProposalBounds } from "./proposal"

const files = ["a.json", "b.json", "c.json", "d.json", "e.json", "f.json"]
const bounds: ProposalBounds = {
  snapshot: files,
  head: ["a.json", "b.json", "c.json"],
  maxSummaries: 2,
}

function summary(covers: string[], extra: Record<string, unknown> = {}) {
  return { covers, title: "Phase", found: [], decided: ["x"], open: [], ...extra }
}

function run(summaries: unknown[], b: ProposalBounds = bounds) {
  return parseProposal(JSON.stringify({ summaries }), b)
}

function errorsOf(result: ReturnType<typeof parseProposal>): string[] {
  return result.ok ? [] : result.errors
}

describe("parseProposal", () => {
  test("accepts two contiguous summaries covering the head", () => {
    const result = run([summary(["a.json"]), summary(["b.json", "c.json"])])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposal.summaries[0].trace).toBeNull()
  })

  test("accepts a fenced message and a title-only summary", () => {
    const body = JSON.stringify({
      summaries: [summary(["a.json", "b.json", "c.json"], { decided: [] })],
    })
    expect(parseProposal("```json\n" + body + "\n```\n", bounds).ok).toBe(true)
  })

  test("rejects invalid JSON and wrong shapes", () => {
    expect(errorsOf(parseProposal("not json", bounds))[0]).toContain("not valid JSON")
    expect(errorsOf(parseProposal("[]", bounds))).toEqual(["proposal is not a JSON object"])
    expect(errorsOf(run([{ covers: ["a.json"], title: " ", found: "x" }])).length).toBe(4)
  })

  test("rejects ranges touching the tail or unknown files", () => {
    const errors = errorsOf(run([summary(["a.json", "b.json", "c.json", "d.json"])]))
    expect(errors).toContain("summaries[0] covers d.json outside the head")
    expect(errorsOf(run([summary(["a.json", "b.json", "c.json", "z.json"])]))).toContain(
      "summaries[0] covers unknown file z.json",
    )
  })

  test("rejects non-contiguous, overlapping and incomplete coverage", () => {
    expect(errorsOf(run([summary(["a.json", "c.json"]), summary(["b.json"])]))).toContain(
      "summaries[0] covers a non-contiguous range",
    )
    expect(errorsOf(run([summary(["a.json", "b.json"]), summary(["b.json", "c.json"])]))).toContain(
      "b.json is covered more than once",
    )
    expect(errorsOf(run([summary(["a.json", "b.json"])]))).toEqual([
      "head entry c.json is not covered",
    ])
  })

  test("rejects empty and too many summaries", () => {
    expect(errorsOf(run([]))).toContain("proposal has no summaries")
    const three = [summary(["a.json"]), summary(["b.json"]), summary(["c.json"])]
    expect(errorsOf(run(three))).toContain("3 summaries exceed the limit of 2")
    expect(errorsOf(run([summary([]), summary(["a.json", "b.json", "c.json"])]))).toContain(
      "summaries[0] covers no entries",
    )
  })
})
