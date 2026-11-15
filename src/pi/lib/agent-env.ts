/** Environment variable carrying the cue-agent agent name into a child run. */
export const AGENT_NAME_ENV = "CUE_AGENT_NAME"

/** A cue-agent run spec task env overlay; `null` removes a variable. */
export type TaskEnv = Record<string, string | null>

/**
 * Return the task with `CUE_AGENT_NAME=<agent>` added to its env overlay,
 * so the child pi knows which agent it runs as.
 */
export function withAgentName<T extends { agent: string; env?: TaskEnv }>(task: T): T & { env: TaskEnv } {
  return { ...task, env: { ...task.env, [AGENT_NAME_ENV]: task.agent } }
}
