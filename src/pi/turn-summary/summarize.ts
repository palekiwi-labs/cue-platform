import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanSummary } from "./clean"

/** A summary and the run that produced it. */
export interface SummaryRun {
  text: string
  model?: string
  runId?: string
  promptHash?: string
}

/** The cue-agent agent that writes turn summaries. */
export const SUMMARIZER_AGENT = "summarizer"

/** Set in the summarizer's environment so its own pi never auto-summarizes. */
export const SUMMARIZER_ENV = "CUE_TURN_SUMMARIZER"

const MAX_INPUT = 60_000

/** Instruction sent after the turn so the rules are fresh when the model answers. */
export const SUMMARIZER_REMINDER = readFileSync(new URL("./reminder.txt", import.meta.url), "utf8").trim()

function run(argv: string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, [SUMMARIZER_ENV]: "1" }
    delete env.BUN_BE_BUN
    const child = spawn("cue-agent", argv, { stdio: ["pipe", "pipe", "pipe"], env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

export function summarizerPrompt(prompt: string, text: string): string {
  const body = text.length > MAX_INPUT ? text.slice(-MAX_INPUT) : text
  return [
    "<user-request>",
    prompt,
    "</user-request>",
    "",
    "<assistant-output>",
    body,
    "</assistant-output>",
    "",
    SUMMARIZER_REMINDER,
  ].join("\n")
}

/** Short sha256 of the system prompt a run was given, if the run kept it. */
function promptHashOf(runPath: string | undefined): string | undefined {
  if (!runPath) return undefined
  try {
    const sp = readFileSync(join(runPath, "system-prompt.md"))
    return createHash("sha256").update(sp).digest("hex").slice(0, 12)
  } catch {
    return undefined
  }
}

/** Summarize a turn through cue-agent and return the cleaned paragraph with its run details. */
export async function summarizeTurn(prompt: string, text: string, cwd: string): Promise<SummaryRun> {
  const spec = { tasks: [{ agent: SUMMARIZER_AGENT, prompt: summarizerPrompt(prompt, text), cwd }] }
  const r = await run(["run", "-", "--json"], JSON.stringify(spec))
  let receipt: {
    runs?: {
      outcome: string
      response: string
      error: string | null
      model?: string
      run_id?: string
      run_path?: string
    }[]
  }
  try {
    receipt = JSON.parse(r.stdout)
  } catch {
    throw new Error(`cue-agent exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
  }
  const one = receipt.runs?.[0]
  if (!one) throw new Error("cue-agent receipt has no run")
  if (one.outcome !== "completed") throw new Error(`${one.outcome}: ${one.error ?? "no error"}`)
  const summary = cleanSummary(one.response)
  if (!summary) throw new Error("summarizer returned no text")
  return { text: summary, model: one.model, runId: one.run_id, promptHash: promptHashOf(one.run_path) }
}
