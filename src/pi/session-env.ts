import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const SESSION_ID_ENV = "PI_SESSION_ID"

export function registerSessionEnv(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  let exported: string | undefined
  pi.on("session_start", (_event, ctx) => {
    exported = ctx.sessionManager.getSessionId()
    env[SESSION_ID_ENV] = exported
  })
  pi.on("session_shutdown", () => {
    if (exported !== undefined && env[SESSION_ID_ENV] === exported) delete env[SESSION_ID_ENV]
    exported = undefined
  })
}
