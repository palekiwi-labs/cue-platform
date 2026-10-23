import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const ACUITY_HOST = process.env.ACUITY_HOST ?? "http://localhost:33222"

export interface SessionIdleEvent {
  type: "session_idle"
  session_id: string
  project_dir: string
  harness: "pi"
  session_title: string | null
}

/**
 * POST one acuity event. Failure-tolerant by design: notifications must
 * never break the agent turn, so network errors and non-ok responses are
 * swallowed (mirrors src/opencode/acuity-plugin.ts postEvent).
 */
export async function postSessionIdle(
  fetchImpl: typeof fetch,
  host: string,
  payload: SessionIdleEvent,
): Promise<void> {
  try {
    const res = await fetchImpl(`${host}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Acuity-Schema": "1",
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      // Swallowed: acuity being down must not disturb the session.
    }
  } catch {
    // Swallowed: same tolerance for connection failures.
  }
}

/**
 * Abridged acuity port: pi's agent_settled is the closest equivalent of
 * opencode's session.idle, and session-idle is the only event in scope.
 */
export function registerAcuityListener(
  pi: ExtensionAPI,
  fetchImpl: typeof fetch = fetch,
  host: string = ACUITY_HOST,
): void {
  pi.on("agent_settled", async (_event, ctx) => {
    await postSessionIdle(fetchImpl, host, {
      type: "session_idle",
      session_id: ctx.sessionManager.getSessionId(),
      project_dir: ctx.cwd,
      harness: "pi",
      session_title: ctx.sessionManager.getSessionName() ?? null,
    })
  })
}
