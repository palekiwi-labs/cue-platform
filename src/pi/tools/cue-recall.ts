import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

/**
 * Recall: "have we already discussed this?" over the cue store.
 *
 * A thin bridge over the `cue-recall` CLI (nix/cue-recall), run in the
 * session cwd so cue resolves the caller's default query scope. There is
 * deliberately no scope parameter: the default scope is also the privacy
 * boundary for what is sent to the remote ranking model.
 *
 * The CLI's JSON report carries the compact text meant for the model in
 * `text`; everything else (results as data, thresholds, diagnostics such
 * as model, tokens and timing) goes to `details`, never to the model.
 */
const parameters = Type.Object({
  query: Type.String({
    description:
      "The topic to look for: a question, prompt, code comment, ticket id " +
      "or address fragment. Phrase it as the topic, not as an instruction.",
  }),
  terms: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Related terms that may appear in stored notes and logs (synonyms, " +
        "identifiers, ticket ids). Improves recall when the query uses " +
        "different words than the store.",
    }),
  ),
  roots: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Context addresses (<org>/<repo>/<context>) whose subtrees are " +
        "boosted in the ranking. A boost, not a filter.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum results to show (default 8).",
    }),
  ),
})

export const RECALL_COMMAND = "cue-recall"
export const RECALL_TIMEOUT_MS = 60_000
const DEFAULT_LIMIT = 8

export interface RecallArgs {
  query: string
  terms?: string[]
  roots?: string[]
  limit?: number
}

/**
 * argv for `cue-recall`. The CLI splits terms and roots on commas, so a
 * comma inside one term splits it into two; harmless for ranking.
 */
export function recallArgv(args: RecallArgs): string[] {
  const argv = [
    "--query",
    args.query,
    "--format",
    "json",
    "--limit",
    String(args.limit ?? DEFAULT_LIMIT),
  ]
  const terms = (args.terms ?? []).map((t) => t.trim()).filter(Boolean)
  if (terms.length) argv.push("--terms", terms.join(","))
  const roots = (args.roots ?? []).map((r) => r.trim()).filter(Boolean)
  if (roots.length) argv.push("--roots", roots.join(","))
  return argv
}

/** Message for a failed run; cue-recall prints its reason to stderr. */
export function recallFailureMessage(
  cwd: string,
  code: number,
  stderr: string,
  stdout: string,
  killed: boolean,
): string {
  if (killed) {
    return `cue-recall timed out or was cancelled in ${cwd}`
  }
  const diagnostic = stderr.trim() || stdout.trim()
  if (!diagnostic) {
    return (
      `cue-recall failed in ${cwd} with exit code ${code} and no output ` +
      "(is cue-recall on PATH?)"
    )
  }
  return `cue-recall failed in ${cwd}: ${diagnostic}`
}

export function cueRecallTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-recall",
    label: "cue recall",
    description:
      "Find cue contexts that already discuss a topic, in the cue query " +
      "scope of the current repository. Use it before starting work on a " +
      "topic, when you meet an unfamiliar reference, or when asked " +
      "whether something was discussed before. Returns ranked context " +
      "addresses with matched evidence, bucketed strong/likely/weak; it " +
      "routes you to contexts to read, it does not answer the question. " +
      "Takes about a second.",
    parameters,
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const result = await pi.exec(RECALL_COMMAND, recallArgv(args), {
        cwd: ctx.cwd,
        signal,
        timeout: RECALL_TIMEOUT_MS,
      })
      if (result.code !== 0 || result.killed) {
        throw new Error(
          recallFailureMessage(
            ctx.cwd,
            result.code,
            result.stderr,
            result.stdout,
            result.killed,
          ),
        )
      }
      let report: Record<string, unknown>
      try {
        report = JSON.parse(result.stdout)
      } catch (error) {
        throw new Error(
          `cue-recall returned invalid JSON: ${(error as Error).message}`,
        )
      }
      const { text, ...details } = report
      if (typeof text !== "string") {
        throw new Error("cue-recall report has no text field")
      }
      return { content: [{ type: "text", text }], details }
    },
  }
}
