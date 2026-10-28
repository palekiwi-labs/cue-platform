import { describe, expect, test } from "bun:test"
import {
  batchTotals,
  displayGroups,
  fmtCost,
  fmtDuration,
  fmtTokens,
  groupBatches,
  groupJobs,
  haystack,
  inputTokens,
  isLive,
  jobState,
  jobTotals,
  parsePs,
  parseReceipt,
  receiptStats,
  type RunRow,
  runState,
  stageLabel,
  stateTone,
} from "./model"

const run = (agent: string, position: number, extra: Record<string, unknown> = {}) => ({
  run_id: `B-${agent}-${position}`,
  agent,
  model: "m",
  position,
  phase: "running",
  run_path: `/runs/${agent}-${position}`,
  elapsed_secs: 5,
  tokens_input: 1200,
  tokens_output: 30,
  cost_usd: 0.01,
  ...extra,
})

const ps = (batches: unknown[]) => JSON.stringify({ batches })

describe("parsePs", () => {
  test("flattens newest batch first, runs by position", () => {
    const rows = parsePs(ps([
      { batch_id: "20261001-000000-aaaaaa", label: "old", state: "finished", started_at: 1, runs: [run("x", 1)] },
      {
        batch_id: "20261002-000000-bbbbbb",
        label: null,
        state: "running",
        started_at: 2,
        runs: [run("b", 2), run("a", 1)],
      },
    ]))
    expect(rows.map((r) => r.runId)).toEqual(["B-a-1", "B-b-2", "B-x-1"])
    expect(rows[0]!.batchState).toBe("running")
    expect(rows[2]!.batchLabel).toBe("old")
  })

  test("reads the result of finished runs", () => {
    const [r] = parsePs(ps([{
      batch_id: "B",
      state: "finished",
      runs: [run("a", 1, { phase: "finished", result: { outcome: "aborted", response: "", error: "stopped" } })],
    }]))
    expect(r!.outcome).toBe("aborted")
    expect(r!.error).toBe("stopped")
  })

  test("tolerates garbage", () => {
    expect(parsePs("not json")).toEqual([])
    expect(parsePs("{}")).toEqual([])
    expect(parsePs(ps([{ runs: [run("a", 1)] }]))).toEqual([])
  })
})

describe("state", () => {
  const [live] = parsePs(ps([{ batch_id: "B", state: "running", runs: [run("a", 1)] }]))
  const [crashed] = parsePs(ps([{ batch_id: "B", state: "crashed", runs: [run("a", 1)] }]))
  const [done] = parsePs(ps([{
    batch_id: "B",
    state: "finished",
    runs: [run("a", 1, { phase: "finished", result: { outcome: "completed" } })],
  }]))

  test("outcome wins, then a crashed batch, then the phase", () => {
    expect(runState(done!)).toBe("completed")
    expect(runState(crashed!)).toBe("crashed")
    expect(runState(live!)).toBe("running")
  })

  test("live only while the supervisor holds the batch and no receipt exists", () => {
    expect(isLive(live!)).toBe(true)
    expect(isLive(crashed!)).toBe(false)
    expect(isLive(done!)).toBe(false)
  })

  test("tones", () => {
    expect(stateTone("completed")).toBe("ok")
    expect(stateTone("timeout")).toBe("bad")
    expect(stateTone("preparing")).toBe("live")
  })
})

describe("labels and tokens", () => {
  test("token counts fit six characters", () => {
    expect([999, 1200, 999_949, 999_950, 1_234_567, 99_994_999, 123_456_789].map(fmtTokens))
      .toEqual(["999", "1.2k", "999.9k", "1.00M", "1.23M", "99.99M", "123M"])
  })

  test("reads run label, context, job and cache tokens from ps", () => {
    const [r] = parsePs(ps([{
      batch_id: "B", label: "batch", state: "running", job: { id: "J", label: "job" },
      runs: [run("a", 1, { label: "task", context: "ctx", tokens_cache_read: 800, tokens_cache_write: 0 })],
    }]))
    expect([r!.label, r!.context, r!.jobId, r!.jobLabel]).toEqual(["task", "ctx", "J", "job"])
    expect(inputTokens(r!)).toBe(2000)
    expect(haystack(r!)).toBe("task batch job a m ctx B J")
  })
})

test("formatting", () => {
  expect(fmtDuration(59)).toBe("59s")
  expect(fmtDuration(95)).toBe("1m35")
  expect(fmtDuration(3720)).toBe("1h02")
  expect(fmtCost(0.0043)).toBe("$0.004")
  expect(fmtCost(null)).toBe("-")
})

describe("groupBatches", () => {
  const row = (batchId: string, position: number, extra: Partial<RunRow> = {}): RunRow => ({
    batchId, batchLabel: `L-${batchId}`, batchState: "running", startedAt: 0, jobId: null, jobLabel: null,
    runId: `${batchId}-${position}`, label: null, context: null, agent: "a", model: "m", position, phase: "running",
    runPath: "", elapsedSecs: null, tokensInput: null, tokensOutput: null, tokensCacheRead: null, tokensCacheWrite: null, costUsd: null,
    outcome: null, response: null, error: null, ...extra,
  })

  test("keeps runs of a batch together in first-appearance order", () => {
    const groups = groupBatches([row("b2", 1), row("b1", 1), row("b2", 2), row("b1", 2)])
    expect(groups.map((g) => g.batchId)).toEqual(["b2", "b1"])
    expect(groups[0]!.runs.map((r) => r.position)).toEqual([1, 2])
  })

  test("totals: done count, longest run, summed cost", () => {
    const [g] = groupBatches([
      row("b", 1, { elapsedSecs: 10, costUsd: 0.5, outcome: "completed" }),
      row("b", 2, { elapsedSecs: 30, costUsd: 0.25 }),
    ])
    expect(batchTotals(g!)).toEqual({ done: 1, total: 2, elapsedSecs: 30, tokensInput: null, costUsd: 0.75 })
  })
})

describe("groupJobs", () => {
  const row = (batchId: string, startedAt: number, jobId: string | null, extra: Partial<RunRow> = {}): RunRow => ({
    batchId, batchLabel: jobId ? `x-${jobId}-${batchId}` : batchId, batchState: "finished", startedAt,
    jobId, jobLabel: jobId ? `job ${jobId}` : null, runId: `${batchId}-1`, label: null, context: null,
    agent: "a", model: "m", position: 1, phase: "finished", runPath: "", elapsedSecs: 10, tokensInput: 1,
    tokensOutput: null, tokensCacheRead: null, tokensCacheWrite: null, costUsd: 0.5, outcome: "completed",
    response: null, error: null, ...extra,
  })

  test("stages of concurrent jobs never interleave; jobs keep their place", () => {
    // ps order: newest batch first, stages of jobs A and B alternating.
    const jobs = groupJobs([
      row("b3", 30, "B"), row("a3", 29, "A"), row("solo", 25, null), row("b1", 11, "B"), row("a1", 10, "A"),
    ])
    expect(jobs.map((j) => j.key)).toEqual(["solo", "B", "A"])
    expect(jobs[1]!.batches.map((b) => b.batchId)).toEqual(["b1", "b3"])
    expect(jobs[0]!.label).toBe("solo")
    expect(jobs[1]!.label).toBe("job B")
  })

  test("job label shows the context slug unless it already names it", () => {
    const jobs = groupJobs([
      row("c1", 40, "C", { context: "o/r/review-x" }),
      row("d1", 30, "D", { context: "o/r/review-y", jobLabel: "PR #1 · review-y · default" }),
      row("e1", 20, null, { context: "o/r/ctx" }),
    ])
    expect(jobs.map((j) => j.label)).toEqual(["job C · review-x", "PR #1 · review-y · default", "e1 · ctx"])
  })

  test("job totals span first start to last end; state is live if any stage is", () => {
    const [j] = groupJobs([row("a3", 29, "A", { batchState: "running" }), row("a1", 10, "A")])
    expect(jobTotals(j!)).toEqual({ done: 2, total: 2, elapsedSecs: 29, tokensInput: 2, costUsd: 1 })
    expect(jobState(j!)).toBe("running")
  })

  test("stage label drops the job id prefix", () => {
    const [j] = groupJobs([row("merge", 1, "J1")])
    expect(stageLabel(j!.batches[0]!, "J1")).toBe("merge")
  })

  test("display groups list runs flat in stage order, one group per job or batch", () => {
    const two = (id: string) => [
      row(id, 5, null, { runId: `${id}-1` }),
      row(id, 5, null, { runId: `${id}-2`, position: 2 }),
    ]
    const groups = displayGroups([
      row("a3", 29, "A", { label: "verify" }), row("solo", 25, null), ...two("pair"), row("a1", 10, "A"),
    ])
    expect(groups.map((g) => g.key)).toEqual(["solo", "A", "pair"])
    expect(groups[1]!.runs.map((r) => r.label)).toEqual(["a1", "verify"])
    expect(groups[2]!.runs.map((r) => r.row.runId)).toEqual(["pair-1", "pair-2"])
  })
})

describe("receiptStats", () => {
  const receipt = JSON.stringify({
    agent: "claude",
    harness: "claude-code",
    model: "opus",
    outcome: "completed",
    exit_code: 0,
    duration_ms: 151932,
    turns: 31,
    tokens_input: 54,
    tokens_output: 13495,
    cost_usd: 1.341191,
    response: "the full agent response",
    events_malformed: 0,
    events_oversized: 2,
    events_truncated: true,
    stderr_excerpt: "boom",
    cleanup_errors: ["unlink failed"],
  })
  const row = (extra: Partial<RunRow> = {}): RunRow => ({
    batchId: "B", batchLabel: null, batchState: "finished", jobId: null, jobLabel: null,
    startedAt: 1, runId: "B-1", label: null, context: null, agent: "claude", model: "opus",
    position: 1, phase: "finished", runPath: "/runs/B-1", elapsedSecs: 152,
    tokensInput: 54, tokensOutput: 13495, tokensCacheRead: 465000, tokensCacheWrite: 55600,
    costUsd: 1.34, outcome: "completed", response: null, error: null,
    ...extra,
  })

  test("parses and keeps only the stats fields", () => {
    const rec = parseReceipt(receipt)
    expect(rec).toBeDefined()
    expect(rec!.eventsOversized).toBe(2)
    expect(rec!.cleanupErrors).toEqual(["unlink failed"])
  })

  test("renders fenced yaml with the ps cache split and diagnostics", () => {
    const md = receiptStats(parseReceipt(receipt)!, row())
    expect(md.split("\n")[0]).toBe("```yaml")
    expect(md).toContain("agent: claude / claude-code")
    expect(md).toContain("outcome: completed (exit 0)")
    expect(md).toContain("duration: 2m32")
    expect(md).toContain("turns: 31")
    expect(md).toContain("tokens: 54 in / 465.0k cache read / 55.6k cache write / 13.5k out")
    expect(md).toContain("cost: $1.34")
    expect(md).toContain("events: 2 oversized, truncated")
    expect(md).toContain("stderr: boom")
    expect(md).toContain("cleanup_errors: unlink failed")
    expect(md).not.toContain("the full agent response")
  })

  test("falls back to ps numbers and omits empty diagnostics", () => {
    const bare = parseReceipt(JSON.stringify({ agent: "x", outcome: "failed" }))!
    const md = receiptStats(bare, row({ tokensCacheRead: null, tokensCacheWrite: null }))
    expect(md).toContain("model: opus")
    expect(md).toContain("outcome: failed")
    expect(md).not.toContain("cache read: -")
  })

  test("rejects unreadable receipts", () => {
    expect(parseReceipt("not json")).toBeUndefined()
  })
})
