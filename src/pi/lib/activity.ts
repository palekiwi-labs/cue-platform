import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { cueFailureMessage } from "./cue-exec"
import { provenanceFlags } from "./cue-args"
import { currentContext } from "./current-context"

/**
 * Harness-side producers for cue context activity (`cue activity add`).
 *
 * cue records artifact_created natively; the harness owns the events cue
 * cannot see: session_associated and git_commit. Recording is a
 * side channel: it never changes the outcome of the observed action, so
 * every failure becomes a warning.
 */

export type ActivityKind = "session_associated" | "git_commit"

/** The slice of a pi extension context the recorder needs. */
export interface ActivityCtx {
  cwd: string
  hasUI?: boolean
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void }
  sessionManager: { getSessionId(): string }
}

/** argv for `cue activity add`, provenance included. */
export function activityArgv(
  address: string,
  kind: ActivityKind,
  details: Record<string, unknown>,
  sessionId: string | undefined,
): string[] {
  return [
    "activity",
    "add",
    "--context",
    address,
    "--kind",
    kind,
    "--details",
    JSON.stringify(details),
    ...provenanceFlags(sessionId),
  ]
}

function warn(ctx: ActivityCtx, message: string): void {
  if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, "warning")
  else console.error(message)
}

/**
 * Record one activity event into the session's context.
 *
 * An undefined address means the session has no context: skip without
 * calling cue, since cue would fall back to $CUE_CONTEXT or the branch
 * configuration, which is not the session's association.
 */
export async function recordActivity(
  pi: ExtensionAPI,
  ctx: ActivityCtx,
  address: string | undefined,
  kind: ActivityKind,
  details: Record<string, unknown>,
): Promise<void> {
  if (!address) return
  try {
    const argv = activityArgv(
      address,
      kind,
      details,
      ctx.sessionManager.getSessionId(),
    )
    const r = await pi.exec("cue", argv, { cwd: ctx.cwd })
    if (r.code !== 0) {
      warn(
        ctx,
        `cue: activity not recorded: ${cueFailureMessage(argv, ctx.cwd, r.code, r.stderr, r.stdout)}`,
      )
    }
  } catch (err) {
    warn(ctx, `cue: activity not recorded: ${(err as Error).message ?? err}`)
  }
}

/**
 * Split a shell command into word lists, one per segment, on unquoted
 * `&&`, `||`, `;` and newlines. Quotes and backslashes are honoured so a
 * separator or `git commit` inside a string never starts a segment.
 */
function segments(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ""
  let inWord = false
  let quote: "'" | '"' | undefined
  const endWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ";" || c === "\n") {
      endSegment()
    } else if ((c === "&" || c === "|") && command[i + 1] === c) {
      endSegment()
      i++
    } else if (c === " " || c === "\t") {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function segmentIsCommit(words: string[]): boolean {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
  if (words[i] !== "git") return false
  i++
  while (words[i] === "-C" || words[i] === "-c") i += 2
  return words[i] === "commit"
}

/**
 * True when some segment of a bash command runs `git commit`: optional
 * VAR=value assignments, git, any -C/-c options, then the commit
 * subcommand. Mentions inside quotes or other commands do not match.
 */
export function isGitCommit(command: string): boolean {
  return segments(command).some(segmentIsCommit)
}

/** One commit summary line printed by `git commit`. */
export interface CommitLine {
  short: string
  branch: string | null
  title: string
}

const COMMIT_LINE = /^\[(.+?) ([0-9a-f]{7,40})\] (.*)$/

/**
 * Parse the `[<branch> <hash>] <title>` lines `git commit` prints, e.g.
 * `[dev 6c9688b] x`, `[master (root-commit) 4fa6186] x` or
 * `[detached HEAD 1a2b3c4] x`. Detached HEAD yields a null branch.
 */
export function commitLines(output: string): CommitLine[] {
  const out: CommitLine[] = []
  for (const line of output.split("\n")) {
    const m = COMMIT_LINE.exec(line)
    if (!m) continue
    const ref = m[1]!.replace(/ \(root-commit\)$/, "")
    out.push({
      short: m[2]!,
      branch: ref === "detached HEAD" ? null : ref,
      title: m[3]!,
    })
  }
  return out
}

function cdTarget(dir: string, arg: string): string {
  if (arg === "~") return homedir()
  if (arg.startsWith("~/")) return resolve(homedir(), arg.slice(2))
  return resolve(dir, arg)
}

/**
 * Directories the `git commit` segments of a command run in: the session
 * cwd, moved by preceding `cd <path>` segments, then by any `-C` options.
 * `cd` without a usable path argument leaves the directory unchanged.
 */
export function commitDirs(command: string, cwd: string): string[] {
  const dirs: string[] = []
  let dir = cwd
  for (const words of segments(command)) {
    if (words[0] === "cd") {
      const arg = words[1]
      if (arg && arg !== "-") dir = cdTarget(dir, arg)
      continue
    }
    if (!segmentIsCommit(words)) continue
    let target = dir
    for (let i = words.indexOf("git") + 1; i < words.length; i += 2) {
      if (words[i] === "-C" && words[i + 1]) target = resolve(target, words[i + 1]!)
      else if (words[i] !== "-c") break
    }
    if (!dirs.includes(target)) dirs.push(target)
  }
  return dirs
}

/** `<org>/<repo>` from an origin URL or path, as cue derives its scopes. */
export function originScope(origin: string): string | null {
  let o = origin.trim().replace(/\/+$/, "").replace(/\.git$/, "")
  const colon = o.lastIndexOf(":")
  const scheme = o.indexOf("://")
  if (scheme >= 0) {
    const rest = o.slice(scheme + 3)
    const slash = rest.indexOf("/")
    if (slash < 0) return null
    o = rest.slice(slash + 1)
  } else if (colon >= 0) {
    o = o.slice(colon + 1)
  }
  const parts = o.split("/").filter((p) => p !== "" && p !== ".")
  if (parts.length < 2) return null
  return parts.slice(-2).join("/")
}

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const r = await pi.exec("git", args, { cwd })
    return r.code === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/**
 * Record git_commit for every commit a bash tool call (nested codemode
 * calls included) proves it made: one event per `[<branch> <hash>] title`
 * line in the output of a command that runs `git commit`. The call's exit
 * status is irrelevant; the output line is the proof. The short hash is
 * resolved in the directories the commit segments ran in, so a line that
 * resolves nowhere records nothing. Quiet commits (-q) print no line and
 * are not recorded. Merges and user `!` bash are not observed.
 */
export function registerActivityRecording(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return
    const command = event.input.command
    if (typeof command !== "string" || !isGitCommit(command)) return
    const lines = commitLines(outputText(event.content))
    if (lines.length === 0) return
    const address = currentContext(ctx.sessionManager.getBranch())
    if (!address) return
    const dirs = commitDirs(command, ctx.cwd)
    const seen = new Set<string>()
    for (const line of lines) {
      for (const dir of dirs) {
        const hash = await git(pi, dir, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${line.short}^{commit}`,
        ])
        if (!hash) continue
        if (seen.has(hash)) break
        seen.add(hash)
        const root = await git(pi, dir, ["rev-parse", "--show-toplevel"])
        const origin = await git(pi, dir, ["remote", "get-url", "origin"])
        await recordActivity(pi, ctx, address, "git_commit", {
          hash,
          branch: line.branch,
          title: line.title,
          repo: origin ? originScope(origin) : null,
          root,
        })
        break
      }
    }
  })
}
