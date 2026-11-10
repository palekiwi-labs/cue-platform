import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TurnSummaryData } from "./turns"

/** The cue context that collects summary feedback. */
export const FEEDBACK_CONTEXT = "palekiwi/palekiwi/turn-summary-feedback"

const FEEDBACK_REPO = join(homedir(), "code/palekiwi/palekiwi")

/** Everything a feedback note records about one reported summary. */
export interface FeedbackReport {
  comment: string
  summary: TurnSummaryData
  input: string
  sessionFile?: string
  cwd: string
  date: Date
}

export interface FeedbackNote {
  filename: string
  frontmatter: Record<string, string>
  body: string
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "report"
}

function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = "`".repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Build the note for a report; the comment's first line is its title. */
export function feedbackNote(r: FeedbackReport): FeedbackNote {
  const comment = r.comment.trim()
  const title = comment.split("\n")[0]!.trim()
  const frontmatter: Record<string, string> = { status: "open", title, turn_id: r.summary.turnId, cwd: r.cwd }
  if (r.summary.model) frontmatter.model = r.summary.model
  if (r.summary.promptHash) frontmatter.prompt_hash = r.summary.promptHash
  if (r.summary.runId) frontmatter.run_id = r.summary.runId
  if (r.sessionFile) frontmatter.session_file = r.sessionFile
  const body = [
    "## Comment",
    "",
    comment,
    "",
    "## Summary",
    "",
    fenced(r.summary.text),
    "",
    "## Input",
    "",
    fenced(r.input),
    "",
  ].join("\n")
  return { filename: `summarizer-feedback/${localDate(r.date)}-${slugOf(title)}.md`, frontmatter, body }
}

/** Write a feedback note with the cue CLI and return the path it printed. */
export function writeFeedbackNote(note: FeedbackNote): Promise<string> {
  const argv = ["-C", FEEDBACK_REPO, "add", "--type", "note", "--context", FEEDBACK_CONTEXT]
  for (const [k, v] of Object.entries(note.frontmatter)) argv.push("-f", `${k}=${v.replace(/\s+/g, " ")}`)
  argv.push(note.filename, "-")
  return new Promise((resolve, reject) => {
    const child = spawn("cue", argv, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `cue add exit ${code}`)),
    )
    child.stdin.end(note.body)
  })
}
