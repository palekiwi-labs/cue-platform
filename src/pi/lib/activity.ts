import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { cueFailureMessage } from "./cue-exec"
import { provenanceFlags } from "./cue-args"

/**
 * Harness-side producers for cue context activity (`cue activity add`).
 *
 * cue records artifact_created natively; the harness owns the events cue
 * cannot see: session_associated and git_commit_attempt. Recording is a
 * side channel: it never changes the outcome of the observed action, so
 * every failure becomes a warning.
 */

export type ActivityKind = "session_associated" | "git_commit_attempt"

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
