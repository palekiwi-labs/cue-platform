import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type BranchEntry, currentContext, slugOf } from "./current-context"

/**
 * The session's active task: the newest `custom` entry of this type on
 * the active branch. `data.address` is the task's canonical address, or
 * null when the task was cleared. A task only counts while its context
 * is the session's current context.
 */
export const SESSION_TASK_TYPE = "cue-session-task"

/** Environment variable carrying the active task address to child processes. */
export const TASK_ENV = "CUE_TASK"

/** Footer status key for the session's context and task. */
export const SESSION_STATUS_KEY = "cue-session"

export interface SessionTaskData {
  address: string | null
}

/**
 * Context address of a canonical task address
 * (`<org>/<repo>/<context>/task/<name>`), or undefined when the address
 * does not name a task.
 */
export function taskContextOf(address: string): string | undefined {
  const parts = address.trim().split("/").filter((p) => p !== "")
  if (parts.length < 5 || parts[3] !== "task") return undefined
  if (parts.some((p) => p === "." || p === "..")) return undefined
  return parts.slice(0, 3).join("/")
}

/** Normalised canonical task address, or undefined when not a task address. */
export function normalizeTaskAddress(address: string): string | undefined {
  if (!taskContextOf(address)) return undefined
  return address.trim().split("/").filter((p) => p !== "").join("/")
}

/** Active task on the branch, or undefined when none is set or it is stale. */
export function currentTask(branch: readonly BranchEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!
    if (e.type !== "custom" || e.customType !== SESSION_TASK_TYPE) continue
    const address = (e.data as Partial<SessionTaskData> | undefined)?.address
    if (typeof address !== "string" || address === "") return undefined
    return taskContextOf(address) === currentContext(branch) ? address : undefined
  }
  return undefined
}

/** Footer text: context slug, plus the task slug when a task is active. */
export function sessionStatusText(
  context: string | undefined,
  task: string | undefined,
): string | undefined {
  if (!context) return undefined
  if (!task) return slugOf(context)
  return `${slugOf(context)} / ${slugOf(task).replace(/\.md$/, "")}`
}

export interface SessionStateCtx {
  hasUI?: boolean
  ui?: {
    setStatus(key: string, text: string | undefined): void
    theme?: { fg(color: "error", text: string): string }
  }
  sessionManager: { getBranch(): readonly BranchEntry[] }
}

/**
 * Bring the environment and footer in line with the branch: CUE_TASK
 * holds the active task (unset without one) and the footer shows the
 * context and task, or a red "no context".
 */
export function syncSessionState(
  ctx: SessionStateCtx,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const branch = ctx.sessionManager.getBranch()
  const task = currentTask(branch)
  if (task) env[TASK_ENV] = task
  else delete env[TASK_ENV]
  if (!ctx.hasUI || !ctx.ui) return
  const text =
    sessionStatusText(currentContext(branch), task) ??
    (ctx.ui.theme ? ctx.ui.theme.fg("error", "no context") : "no context")
  ctx.ui.setStatus(SESSION_STATUS_KEY, text)
}

/** Record the active task (null clears it) and resync env and footer. */
export function setSessionTask(
  pi: ExtensionAPI,
  ctx: SessionStateCtx,
  address: string | null,
): void {
  const data: SessionTaskData = { address }
  pi.appendEntry(SESSION_TASK_TYPE, data)
  syncSessionState(ctx)
}

/**
 * Clear the active task when the session is about to associate a
 * different context, so relinking the task's old context later does
 * not bring the task back.
 */
export function clearTaskOutside(
  pi: ExtensionAPI,
  ctx: SessionStateCtx,
  context: string,
): void {
  const task = currentTask(ctx.sessionManager.getBranch())
  if (task && taskContextOf(task) !== context) {
    pi.appendEntry(SESSION_TASK_TYPE, { address: null } satisfies SessionTaskData)
  }
}

/**
 * Why linking `context` must be refused, or undefined when it may
 * proceed: a session with an active task stays in the task's context
 * until the task is cleared.
 */
export function linkGuardError(
  branch: readonly BranchEntry[],
  context: string,
): string | undefined {
  const task = currentTask(branch)
  if (!task || taskContextOf(task) === context) return undefined
  return (
    `active task ${task} belongs to ${taskContextOf(task)}; ` +
    "clear it first (cue-session-task with no address) or set a task in " +
    `${context} instead`
  )
}
