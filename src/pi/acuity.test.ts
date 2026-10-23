import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { postSessionIdle, registerAcuityListener } from "./acuity"

interface FetchCall {
  url: string
  init: RequestInit
}

function okResponse(): Response {
  return { ok: true, status: 200, statusText: "OK" } as unknown as Response
}

function makeFetch(result: () => Promise<Response> = () => Promise.resolve(okResponse())) {
  const calls: FetchCall[] = []
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return result()
  }) as unknown as typeof fetch
  return { fn, calls }
}

const payload = {
  type: "session_idle" as const,
  session_id: "sess-1",
  project_dir: "/work",
  harness: "pi" as const,
  session_title: "My session",
}

describe("postSessionIdle", () => {
  test("posts the session_idle payload with the acuity schema header", async () => {
    const { fn, calls } = makeFetch()
    await postSessionIdle(fn, "http://localhost:33222", payload)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:33222/events")
    expect(calls[0].init.method).toBe("POST")
    expect((calls[0].init.headers as Record<string, string>)["X-Acuity-Schema"]).toBe("1")
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    )
    expect(JSON.parse(calls[0].init.body as string)).toEqual(payload)
  })

  test("swallows network failures", async () => {
    const { fn } = makeFetch(() => Promise.reject(new Error("connection refused")))
    await expect(
      postSessionIdle(fn, "http://localhost:33222", payload),
    ).resolves.toBeUndefined()
  })

  test("swallows non-ok responses", async () => {
    const { fn } = makeFetch(() =>
      Promise.resolve({ ok: false, status: 500, statusText: "boom" } as unknown as Response),
    )
    await expect(
      postSessionIdle(fn, "http://localhost:33222", payload),
    ).resolves.toBeUndefined()
  })
})

describe("registerAcuityListener", () => {
  function listenerCtx(title?: string): ExtensionContext {
    return {
      cwd: "/work",
      sessionManager: {
        getSessionId: () => "sess-1",
        getSessionName: () => title,
      },
    } as unknown as ExtensionContext
  }

  test("posts session_idle on agent_settled with session id and title", async () => {
    const { fn, calls } = makeFetch()
    const handlers: Record<string, (e: unknown, ctx: ExtensionContext) => Promise<void>> = {}
    const pi = {
      on: (event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) => {
        handlers[event] = handler
      },
    } as unknown as ExtensionAPI

    registerAcuityListener(pi, fn)
    expect(handlers["agent_settled"]).toBeDefined()

    await handlers["agent_settled"]({ type: "agent_settled" }, listenerCtx("My session"))
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      type: "session_idle",
      session_id: "sess-1",
      project_dir: "/work",
      harness: "pi",
      session_title: "My session",
    })
  })

  test("falls back to a null title when the session is unnamed", async () => {
    const { fn, calls } = makeFetch()
    const handlers: Record<string, (e: unknown, ctx: ExtensionContext) => Promise<void>> = {}
    const pi = {
      on: (event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) => {
        handlers[event] = handler
      },
    } as unknown as ExtensionAPI

    registerAcuityListener(pi, fn)
    await handlers["agent_settled"]({ type: "agent_settled" }, listenerCtx(undefined))
    expect(JSON.parse(calls[0].init.body as string).session_title).toBeNull()
  })

  test("agent_settled handler never rejects even when posting fails", async () => {
    const { fn } = makeFetch(() => Promise.reject(new Error("down")))
    const handlers: Record<string, (e: unknown, ctx: ExtensionContext) => Promise<void>> = {}
    const pi = {
      on: (event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) => {
        handlers[event] = handler
      },
    } as unknown as ExtensionAPI

    registerAcuityListener(pi, fn)
    await expect(
      handlers["agent_settled"]({ type: "agent_settled" }, listenerCtx()),
    ).resolves.toBeUndefined()
  })
})
