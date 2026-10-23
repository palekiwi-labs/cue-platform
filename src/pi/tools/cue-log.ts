import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { runCue } from "../lib/cue-exec"
import { buildReport, contextNote } from "../lib/context-usage"
import { withTempFile } from "../lib/temp"

const parameters = Type.Object({
  title: Type.String({
    description: "Concise summary of the milestone, commit, or discovery.",
  }),
  trace: Type.Optional(
    Type.String({
      description:
        "Canonical address of a trace artifact (e.g. " +
        "'palekiwi/palekiwi/cue-platform-direction/trace/handoff.md'), " +
        "resolved against the store root. Must name an existing file " +
        "inside the logged context's trace/ directory; any other address " +
        "is rejected. Attach one only when a successor needs context " +
        "beyond the found/decided/open bullets, such as at a hand-off.",
    }),
  ),
  found: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Discovered facts, unexpected behaviors, system quirks, or root " +
        "causes. Do NOT record passing test counts, linter outputs, or " +
        "clean git statuses. Omit if empty.",
    }),
  ),
  decided: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Architectural choices, trade-offs made, or abandoned/rejected " +
        "approaches. Do NOT record mechanical code edits, routine renames, " +
        "or commit actions. Omit if empty.",
    }),
  ),
  open: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Unresolved domain ambiguities, pending stakeholder decisions, or " +
        "external blockers. Do NOT record next-step plan items or workflow " +
        "actions. Omit if empty.",
    }),
  ),
  context: Type.String({
    description:
      "Context slug to log against, within the repository's scope. " +
      "Required: cue has no default or fallback context and a write with " +
      "none fails. A context's recency is the newest entry in its log, so " +
      "logging is what keeps it findable.",
  }),
  dir: Type.Optional(
    Type.String({
      description:
        "Run cue as if started in this directory instead of the session " +
        "directory. Mirrors the git -C convention; use to log against " +
        "another repository's scope.",
    }),
  ),
  store: Type.Optional(
    Type.String({
      description: "Root of the cue store, overriding $CUE_STORE. Rarely needed.",
    }),
  ),
})

/**
 * One-line context saturation note appended to the tool output so agents
 * learn saturation level at natural checkpoints without a dedicated query.
 * Uses pi's native ctx.getContextUsage(); fails silent — a note is never
 * worth failing the log over (tokens can be null right after compaction).
 */
function contextStateLine(ctx: { getContextUsage?: () => { tokens: number | null } | undefined }): string {
  try {
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined
    if (!usage || usage.tokens == null) {
      return ""
    }
    return contextNote(buildReport(usage.tokens).level)
  } catch {
    return ""
  }
}

export function cueLogTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-log",
    label: "cue log",
    description:
      "Add a structured milestone, discovery, or post-commit log entry to " +
      "the cue memory system.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      // Absent fields are dropped by JSON.stringify rather than
      // serialised as null, which cue's entry reader rejects for the
      // array fields.
      const payload = JSON.stringify({
        title: args.title,
        trace: args.trace,
        found: args.found,
        decided: args.decided,
        open: args.open,
      })

      const output = await withTempFile(payload, "cue-log", "json", async (tempPath) => {
        const flags = [
          ...dirFlag(args.dir, ctx.cwd),
          ...storeFlag(args.store),
          ...contextFlag(args.context),
        ]
        return runCue(pi, ["log", "add", ...flags, "--file", tempPath], ctx.cwd)
      })

      const note = contextStateLine(ctx)
      const text = note
        ? `Logged milestone: ${args.title}\n${note}`
        : `Logged milestone: ${args.title}`
      return { content: [{ type: "text", text }], details: {} }
    },
  }
}
