import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { registerSessionEnv, SESSION_ID_ENV } from "./session-env"

function setup(env: NodeJS.ProcessEnv) {
  const handlers = new Map<string, Function>()
  const pi = { on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI
  registerSessionEnv(pi, env)
  const start = (id: string) =>
    handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext)
  return { start, shutdown: () => handlers.get("session_shutdown")!({}) }
}

test("exports the current session id and follows session switches", () => {
  const env: NodeJS.ProcessEnv = { [SESSION_ID_ENV]: "stale" }
  const s = setup(env)
  s.start("first")
  expect(env[SESSION_ID_ENV]).toBe("first")
  s.start("second")
  expect(env[SESSION_ID_ENV]).toBe("second")
  s.shutdown()
  expect(env[SESSION_ID_ENV]).toBeUndefined()
})

test("shutdown keeps an id set by someone else", () => {
  const env: NodeJS.ProcessEnv = {}
  const s = setup(env)
  s.start("mine")
  env[SESSION_ID_ENV] = "other"
  s.shutdown()
  expect(env[SESSION_ID_ENV]).toBe("other")
})

test("child processes inherit the exported id", () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  setup(env).start("child-visible")
  const out = spawnSync("sh", ["-c", `printf %s "$${SESSION_ID_ENV}"`], { env, encoding: "utf8" })
  expect(out.stdout).toBe("child-visible")
})
