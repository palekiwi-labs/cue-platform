import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { execFileSync } from "node:child_process"
import { Type } from "typebox"
import type { RunSpec } from "../../supervisor/spec"
import { parseStatusAddress } from "../commands/context-current"
import { currentContext } from "../lib/current-context"
import { type Roster, formatReceipt } from "../lib/delegate-helpers"
import {
  type DelegateTask,
  type SupervisorRunState,
  formatBackgroundSubmission,
  isTerminal,
  requestIdFor,
  resolveRun,
  toBatchReceipt,
} from "../lib/supervisor-client"
import { connectSupervisor, fetchRuns, submitWithRetry } from "../lib/supervisor-nats"

export const BACKEND_ENV = "CUE_DELEGATE_BACKEND"

export function supervisorBackendSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BACKEND_ENV] === "supervisor"
}

const POLL_MS = 2_000

/** The explicit context, else the session's active context, else an error. */
export function delegateContext(explicit: string | undefined, ctx: ExtensionContext): string {
  if (explicit) return explicit
  const fromSession = currentContext(ctx.sessionManager.getBranch())
  if (fromSession) return fromSession
  let fromCue: string | undefined
  try {
    fromCue = parseStatusAddress(
      execFileSync("cue", ["status", "--json"], { cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    )
  } catch {
    fromCue = undefined
  }
  if (fromCue) return fromCue
  throw new Error("delegate: no cue context; pass context or link the session to one")
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

export interface SupervisorDelegateArgs {
  tasks: DelegateTask[]
  context?: string
  background?: boolean
}

/** Run one delegate call through the supervisor (foreground or background). */
export async function executeSupervisorDelegate(
  toolCallId: string,
  args: SupervisorDelegateArgs,
  roster: Roster,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const context = delegateContext(args.context, ctx)
  const runs: RunSpec[] = args.tasks.map((task) => resolveRun(task, roster, context))
  const agents = args.tasks.map((task) => task.agent)
  const started = Date.now()
  const client = await connectSupervisor()
  try {
    const { batchId, runIds } = await submitWithRetry(client, requestIdFor(toolCallId), { runs })
    if (args.background) {
      return {
        content: [{ type: "text" as const, text: formatBackgroundSubmission(batchId, runIds, agents) }],
        details: { batch_id: batchId, run_ids: runIds },
      }
    }
    for (;;) {
      if (signal?.aborted) {
        await client.request("cancel", { kind: "batch", batchId }).catch(() => undefined)
        throw new Error(`delegate aborted; cancellation requested for batch ${batchId}`)
      }
      const states = await fetchRuns(client, "result", batchId, runIds)
      if (states.every(isTerminal)) {
        const batch = toBatchReceipt(batchId, agents, states, Date.now() - started, runs.flatMap((run) => (run.model ? [run.model] : [])))
        return { content: [{ type: "text" as const, text: formatReceipt(batch, roster) }], details: batch }
      }
      await sleep(POLL_MS, signal)
    }
  } finally {
    await client.close()
  }
}

const statusParameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("cancel")], {
    description: "status: run states; result: final responses; cancel: stop the batch or run.",
  }),
  batchId: Type.Optional(Type.String({ description: "Batch id returned by a background delegate call." })),
  runId: Type.Optional(Type.String({ description: "A single run id; use instead of batchId." })),
})

/** Inspect, collect or cancel supervisor batches started by delegate. */
export function delegateStatusTool(roster: Roster) {
  const tool: ToolDefinition<typeof statusParameters> = {
    name: "delegate-status",
    label: "delegate-status",
    description:
      "Check on, collect results from, or cancel a delegate batch that was started with " +
      "background: true. Pass the batch id (or one run id) from the delegate reply.",
    parameters: statusParameters,
    async execute(_toolCallId, args) {
      const target = args.runId
        ? { kind: "run" as const, runId: args.runId }
        : args.batchId
          ? { kind: "batch" as const, batchId: args.batchId }
          : null
      if (!target) throw new Error("delegate-status: pass batchId or runId")
      const client = await connectSupervisor()
      try {
        if (args.action === "cancel") {
          const report = await client.request("cancel", target)
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report }
        }
        const runs =
          target.kind === "batch"
            ? await fetchRuns(client, args.action, target.batchId, [])
            : (await client.request<{ runs: SupervisorRunState[] }>(args.action, target)).runs
        if (args.action === "status") {
          const text = runs.map((r) => `- ${r.runId}: ${r.state}${r.result ? ` (${r.result.outcome})` : ""}`).join("\n")
          return { content: [{ type: "text", text }], details: { runs } }
        }
        const agents = runs.map((r) => agentOf(r.runId))
        const batch = toBatchReceipt(target.kind === "batch" ? target.batchId : target.runId, agents, runs, 0)
        return { content: [{ type: "text", text: formatReceipt(batch, roster) }], details: batch }
      } finally {
        await client.close()
      }
    },
  }
  return tool
}

function agentOf(runId: string): string {
  const match = /^\d{8}-\d{6}-[0-9a-f]+-(.+)-\d+$/.exec(runId)
  return match ? match[1] : "agent"
}
