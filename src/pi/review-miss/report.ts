import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join, relative } from "node:path"

/** The cue context that collects review miss reports. */
export const MISSES_CONTEXT = "palekiwi/palekiwi/review-misses"

const MISSES_REPO = join(homedir(), "code/palekiwi/palekiwi")

/** Everything a review miss report records. */
export interface MissReport {
  comment: string
  cwd: string
  date: Date
  sessionFile?: string
  sessionId?: string
  transcript?: string
}

export interface MissTrace {
  filename: string
  frontmatter: Record<string, string>
  body: string
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "miss"
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Build the trace for a report; the comment's first line is its title. */
export function missTrace(r: MissReport): MissTrace {
  const comment = r.comment.trim()
  const title = comment.split("\n")[0]!.trim()
  const frontmatter: Record<string, string> = { status: "open", title, cwd: r.cwd }
  if (r.sessionId) frontmatter.session_id = r.sessionId
  if (r.sessionFile) frontmatter.session_file = r.sessionFile
  if (r.transcript) frontmatter.transcript = r.transcript
  const body = ["## Comment", "", comment, ""].join("\n")
  return { filename: `${localDate(r.date)}-${slugOf(title)}.md`, frontmatter, body }
}

/** Convert a path printed by cue into a canonical address. */
export function addressOf(path: string, store = process.env.CUE_STORE ?? join(homedir(), "cue")): string {
  return relative(store, path)
}

/** Derive `<org>/<repo>` from a git remote url. */
export function repoIdOf(url: string): string | undefined {
  return url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
}

function run(cmd: string, argv: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${cmd} exit ${code}`)),
    )
    child.stdin.end(stdin ?? "")
  })
}

/** The repository and commit the session's cwd is at, when it is a git checkout. */
export async function revisionOf(cwd: string): Promise<{ repoId: string; commitHash: string } | undefined> {
  try {
    const repoId = repoIdOf(await run("git", ["-C", cwd, "remote", "get-url", "origin"]))
    const commitHash = await run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"])
    return repoId && commitHash ? { repoId, commitHash } : undefined
  } catch {
    return undefined
  }
}

/** Copy the session transcript into the misses context and return its address. */
export async function saveTranscript(sessionFile: string): Promise<string> {
  const argv = ["-C", MISSES_REPO, "add", "--type", "tmp", "--context", MISSES_CONTEXT, "--file", sessionFile]
  const out = await run("cue", [...argv, "session.jsonl"])
  return addressOf(out.split("\n").pop()!.trim())
}

/** Write the report trace, stamped with the revision of the session's cwd when known. */
export async function writeMissTrace(cwd: string, trace: MissTrace): Promise<string> {
  const argv = ["-C", MISSES_REPO, "add", "--type", "trace", "--context", MISSES_CONTEXT]
  for (const [k, v] of Object.entries(trace.frontmatter)) argv.push("-f", `${k}=${v.replace(/\s+/g, " ")}`)
  const rev = await revisionOf(cwd)
  if (rev) argv.push("-f", `repo_id=${rev.repoId}`, "-f", `commit_hash=${rev.commitHash}`)
  argv.push(trace.filename, "-")
  return run("cue", argv, trace.body)
}
