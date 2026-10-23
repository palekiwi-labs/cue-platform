import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { execFileSync, spawn } from "node:child_process"
import { resolve } from "node:path"
import { Type } from "typebox"
import {
  type BatchReceipt,
  type Roster,
  MAX_TASKS,
  buildDescription,
  formatReceipt,
  parseAgentList,
  selectableAliases,
} from "../lib/delegate-helpers"

const BINARY = "cue-agent"

function makeParameters(names: string[], aliases: string[]) {
  return Type.Object({
    tasks: Type.Array(
      Type.Object({
        agent: Type.Unsafe<string>({
          type: "string",
          enum: names,
          description: "Name of an agent from the list in the tool description.",
        }),
        prompt: Type.String({
          description:
            "Self-contained instructions. The agent cannot see this " +
            "conversation; include the goal, paths, facts, and what to return.",
        }),
        model: Type.Optional(
          Type.Unsafe<string>({
            type: "string",
            enum: aliases,
            description:
              "Model alias for this task; must be in the agent's allowlist " +
              "shown in the tool description. Omit to use the agent's " +
              "default (marked *).",
          }),
        ),
        dir: Type.Optional(
          Type.String({
            description:
              "Directory the agent runs in (child pi loads that repo's " +
              "AGENTS.md and project files). Absolute, or relative to the " +
              "session directory (git -C convention). Omit for the session " +
              "cwd; ignored when worktree is set.",
          }),
        ),
        worktree: Type.Optional(
          Type.Union(
            [
              Type.Boolean({
                description:
                  "Shorthand for { base: 'HEAD' }: throwaway worktree at " +
                  "the session repo's current HEAD.",
              }),
              Type.Object({
                base: Type.String({
                  description:
                    "Git revision (commit hash, branch, or tag) the " +
                    "worktree is created at. Pass the reviewed commit " +
                    "hash so every agent in a workflow sees the same " +
                    "pinned tree even if the operator keeps committing.",
                }),
              }),
            ],
            {
              description:
                "Run in a throwaway git worktree of the session repo, " +
                "deleted when the task finishes. Use when the agent must " +
                "see the source while you keep editing the branch (e.g. " +
                "code reviews).",
            },
          ),
        ),
      }),
      {
        minItems: 1,
        maxItems: MAX_TASKS,
        description: `1 to ${MAX_TASKS} tasks, run in parallel.`,
      },
    ),
    context: Type.Optional(
      Type.String({
        description:
          "Optional canonical cue context address '<org>/<repo>/<context>' " +
          "(must already exist) to capture each run as a trace. Omit to " +
          "skip capture.",
      }),
    ),
  })
}

/** Read the merged agent roster once, at extension load. */
function loadRoster(cwd: string): { roster: Roster; error?: string } {
  try {
    const stdout = execFileSync(BINARY, ["agents", "list", "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { roster: parseAgentList(stdout) }
  } catch (err) {
    return { roster: { agents: [], models: {} }, error: (err as Error).message }
  }
}

/** Run `cue-agent run - --json` with the spec on stdin; abort kills it. */
function runBatch(
  spec: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(BINARY, ["run", "-", "--json"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const onAbort = () => child.kill("SIGTERM")
    signal?.addEventListener("abort", onAbort, { once: true })
    child.on("error", reject)
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort)
      resolvePromise({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify(spec))
  })
}

export function delegateTool(cwd: string = process.cwd()) {
  const { roster, error } = loadRoster(cwd)
  const names = roster.agents.map((a) => a.name)
  const parameters = makeParameters(names, selectableAliases(roster))
  let description = buildDescription(roster)
  if (error) description += `\n\n(cue-agent unavailable at load: ${error})`

  const tool: ToolDefinition<typeof parameters> = {
    name: "delegate",
    label: "delegate",
    description,
    promptSnippet:
      "Delegate self-contained prompts to named agents, run in parallel; " +
      "keeps your own context small.",
    parameters,
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      // Per-task overrides: model (cue-agent checks it against the agent
      // allowlist), dir (child cwd, so the child pi loads the target repo's
      // AGENTS.md), and worktree (pins the child to a fresh ephemeral
      // checkout; cue-agent sets the child cwd there, so dir is dropped).
      // Boolean true means HEAD at spawn time; { base } pins to an explicit
      // revision so all agents in a workflow see the same tree even if the
      // operator keeps committing.
      const toWorktree = (w: true | { base: string }) =>
        w === true
          ? { base: "HEAD", ephemeral: true }
          : { base: w.base, ephemeral: true }
      const spec = {
        tasks: args.tasks.map((t) => ({
          agent: t.agent,
          prompt: t.prompt,
          ...(t.worktree
            ? { worktree: toWorktree(t.worktree) }
            : { cwd: t.dir ? resolve(ctx.cwd, t.dir) : ctx.cwd }),
          ...(t.model ? { model: t.model } : {}),
          ...(t.worktree ? { worktree: toWorktree(t.worktree) } : {}),
          ...(args.context ? { context: args.context } : {}),
        })),
      }
      const { code, stdout, stderr } = await runBatch(spec, ctx.cwd, signal)

      let batch: BatchReceipt
      try {
        batch = JSON.parse(stdout) as BatchReceipt
      } catch {
        // Admission failures (unknown agent, disallowed model, bad context,
        // ...) print no receipt; cue-agent's message names the fix.
        throw new Error(
          `cue-agent run failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
        )
      }
      return {
        content: [{ type: "text", text: formatReceipt(batch, roster) }],
        details: batch,
      }
    },
  }
  return tool
}
