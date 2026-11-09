import { spawn } from "node:child_process"
import { cleanSummary } from "./clean"

/** The cue-agent agent that writes turn summaries. */
export const SUMMARIZER_AGENT = "summarizer"

const MAX_INPUT = 60_000

function run(argv: string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
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
    "Say the assistant's reply to the user in its own voice, as one short spoken paragraph.",
    "",
    "<user-request>",
    prompt,
    "</user-request>",
    "",
    "<assistant-output>",
    body,
    "</assistant-output>",
  ].join("\n")
}

/** Summarize a turn through cue-agent and return the cleaned paragraph. */
export async function summarizeTurn(prompt: string, text: string, cwd: string): Promise<string> {
  const spec = { tasks: [{ agent: SUMMARIZER_AGENT, prompt: summarizerPrompt(prompt, text), cwd }] }
  const r = await run(["run", "-", "--json"], JSON.stringify(spec))
  let receipt: { runs?: { outcome: string; response: string; error: string | null }[] }
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
  return summary
}
