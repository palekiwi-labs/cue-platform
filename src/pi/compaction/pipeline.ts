import { spawn } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { finalize } from "./finalize"
import { acquireLock, cacheRoot, lockPath } from "./lock"
import { BUNDLE_FILE, contextDir, prepare } from "./prepare"
import { parseProposal } from "./proposal"
import { type CompactionLimits, DEFAULT_LIMITS } from "./split"

/**
 * Background compaction of one context's log: lock, prepare, compactor
 * agent, finalize, release. Runs as a detached process spawned by the
 * trigger (see trigger.ts), so it has no pi ctx; activity is recorded
 * with `cue activity add` directly.
 *
 * Usage: pipeline.ts <store> <address> <run-dir>
 */

export const AGENT = "compactor"
export const PROPOSAL_FILE = "response.md"

export type CompactionKind = "log_compaction_started" | "log_compacted" | "log_compaction_failed"

export interface AgentResult {
  ok: boolean
  /** Final message on success, failure reason otherwise. */
  text: string
}

export interface PipelineDeps {
  runAgent(prompt: string, cwd: string): Promise<AgentResult>
  record(kind: CompactionKind, details: Record<string, unknown>): Promise<void>
}

export interface PipelineArgs {
  store: string
  address: string
  runDir: string
  limits?: CompactionLimits
  /** Host cache root holding the locks. */
  root?: string
}

export type PipelineOutcome = "locked" | "nothing" | "compacted" | "failed"

const OPEN_STATUS = /^status:\s*(open|in-progress)\s*$/m

/** Spec, plans and open tasks of a context, as absolute paths. */
export function contextFiles(dir: string): string[] {
  const md = (sub: string) => {
    try {
      return readdirSync(join(dir, sub))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(dir, sub, f))
    } catch {
      return []
    }
  }
  const tasks = md("task").filter((p) => OPEN_STATUS.test(readFileSync(p, "utf8")))
  return [...md("spec"), ...md("plan"), ...tasks]
}

export function agentPrompt(bundlePath: string, files: string[]): string {
  const list = files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "- (none)"
  return [
    `Compact the log described by this bundle: ${bundlePath}`,
    "",
    "Context files (spec, plans, open tasks):",
    list,
    "",
    "Reply with the proposal JSON only.",
  ].join("\n")
}

export async function runPipeline(args: PipelineArgs, deps: PipelineDeps): Promise<PipelineOutcome> {
  const limits = args.limits ?? DEFAULT_LIMITS
  const release = acquireLock(lockPath(args.root ?? cacheRoot(), args.address))
  if (!release) return "locked"
  const paths = { store: args.store, address: args.address }
  const base = { run_dir: args.runDir }
  try {
    const bundle = prepare({ ...paths, runDir: args.runDir }, limits)
    if (!bundle) return "nothing"
    await deps.record("log_compaction_started", {
      ...base,
      entries: bundle.snapshot.length,
      head: bundle.split.head.length,
      merge: bundle.split.merge.length,
    })
    const fail = async (reason: string): Promise<PipelineOutcome> => {
      await deps.record("log_compaction_failed", { ...base, reason })
      return "failed"
    }
    const prompt = agentPrompt(join(args.runDir, BUNDLE_FILE), contextFiles(contextDir(paths)))
    const agent = await deps.runAgent(prompt, contextDir(paths))
    if (!agent.ok) return fail(`agent: ${agent.text}`)
    writeFileSync(join(args.runDir, PROPOSAL_FILE), agent.text)
    const parsed = parseProposal(agent.text, {
      snapshot: bundle.snapshot.map((s) => s.file),
      head: bundle.split.head,
      maxSummaries: limits.maxSummaries,
    })
    if (!parsed.ok) return fail(`proposal: ${parsed.errors.join("; ")}`)
    const result = finalize(paths, bundle, parsed.proposal)
    if (!result.ok) return fail(`finalize: ${result.reason}`)
    await deps.record("log_compacted", {
      ...base,
      entries_before: bundle.snapshot.length,
      replaced: result.applied.reduce((n, a) => n + a.replaced, 0),
      summaries: result.applied.map((a) => a.summary),
      archives: result.applied.map((a) => a.archive),
    })
    return "compacted"
  } catch (err) {
    await deps.record("log_compaction_failed", { ...base, reason: (err as Error).message ?? String(err) })
    return "failed"
  } finally {
    release()
  }
}

function run(cmd: string, argv: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? "")
  })
}

/** Run the compactor through `cue-agent run - --json` and read its receipt. */
async function cueAgent(prompt: string, cwd: string): Promise<AgentResult> {
  const spec = { tasks: [{ agent: AGENT, prompt, cwd }] }
  const r = await run("cue-agent", ["run", "-", "--json"], JSON.stringify(spec))
  let receipt: { runs?: { outcome: string; response: string; error: string | null; run_path: string }[] }
  try {
    receipt = JSON.parse(r.stdout)
  } catch {
    return { ok: false, text: `cue-agent exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()}` }
  }
  const one = receipt.runs?.[0]
  if (!one) return { ok: false, text: "cue-agent receipt has no run" }
  if (one.outcome !== "completed") {
    return { ok: false, text: `${one.outcome}: ${one.error ?? "no error"} (${one.run_path})` }
  }
  return { ok: true, text: one.response }
}

function cueRecorder(store: string, address: string) {
  return async (kind: CompactionKind, details: Record<string, unknown>) => {
    const argv = ["activity", "add", "--store", store, "--context", address, "--kind", kind, "--details", JSON.stringify(details), "--harness", "pi"]
    try {
      const r = await run("cue", argv)
      if (r.code !== 0) console.error(`activity ${kind} not recorded: ${r.stderr.trim()}`)
    } catch (err) {
      console.error(`activity ${kind} not recorded: ${(err as Error).message}`)
    }
  }
}

if (import.meta.main) {
  const [store, address, runDir] = process.argv.slice(2)
  if (!store || !address || !runDir) {
    console.error("usage: pipeline.ts <store> <address> <run-dir>")
    process.exit(2)
  }
  const outcome = await runPipeline(
    { store, address, runDir },
    { runAgent: cueAgent, record: cueRecorder(store, address) },
  )
  console.log(`${new Date().toISOString()} compaction ${outcome}`)
  process.exit(outcome === "failed" ? 1 : 0)
}
