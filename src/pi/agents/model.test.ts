import { describe, expect, test } from "bun:test"
import {
  fmtCost,
  fmtDuration,
  haystack,
  isLive,
  parseManifest,
  parsePs,
  rowLabel,
  runState,
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

describe("manifest and labels", () => {
  test("task label wins over the batch label", () => {
    const [r] = parsePs(ps([{ batch_id: "B", label: "batch", state: "running", runs: [run("a", 1)] }]))
    expect(rowLabel(r!, undefined)).toBe("batch")
    expect(rowLabel(r!, { label: "task", context: null })).toBe("task")
    expect(haystack(r!, { label: "task", context: "ctx" })).toBe("task batch a m ctx B")
  })

  test("parseManifest", () => {
    expect(parseManifest(JSON.stringify({ label: "l", context: "c" }))).toEqual({ label: "l", context: "c" })
    expect(parseManifest("x")).toEqual({ label: null, context: null })
  })
})

test("formatting", () => {
  expect(fmtDuration(59)).toBe("59s")
  expect(fmtDuration(95)).toBe("1m35")
  expect(fmtDuration(3720)).toBe("1h02")
  expect(fmtCost(0.0043)).toBe("$0.004")
  expect(fmtCost(null)).toBe("-")
})
