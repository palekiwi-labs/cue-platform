import { jetstream } from "@nats-io/jetstream"
import { Kvm } from "@nats-io/kv"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { join } from "node:path"
import type { RunResult } from "../../supervisor/result"
import { batchesDir, readJsonIfExists, runsDir, stateRoot } from "../../supervisor/store"
import type { SupervisorRunState } from "./supervisor-client"
import { API_PREFIX, HEARTBEAT_BUCKET, HEARTBEAT_KEY, HEARTBEAT_TTL_MS } from "../../supervisor/api"

export class SupervisorError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

export interface SupervisorClient {
  request<T>(operation: string, body: unknown, timeoutMs?: number): Promise<T>
  close(): Promise<void>
}

const REQUEST_TIMEOUT_MS = 10_000

/** Connect and fail fast when no live supervisor heartbeat is present. */
export async function connectSupervisor(env: NodeJS.ProcessEnv = process.env): Promise<SupervisorClient> {
  let nc: NatsConnection
  try {
    nc = await connect({
      servers: env.CUE_NATS_URL?.trim() || "nats://127.0.0.1:4222",
      name: "cue-delegate",
      timeout: 2_000,
      reconnect: false,
    })
  } catch (error) {
    throw new SupervisorError("unavailable", `cannot reach NATS: ${(error as Error).message}`)
  }
  try {
    const domain = env.CUE_NATS_JS_DOMAIN === undefined ? "pale" : env.CUE_NATS_JS_DOMAIN.trim()
    const kv = await new Kvm(jetstream(nc, domain ? { domain, timeout: 2_000 } : { timeout: 2_000 })).open(HEARTBEAT_BUCKET)
    const entry = await kv.get(HEARTBEAT_KEY)
    const beat = entry && entry.operation === "PUT" ? (entry.json() as { updatedAt?: number }) : null
    if (!beat || typeof beat.updatedAt !== "number" || Date.now() - beat.updatedAt > HEARTBEAT_TTL_MS) {
      throw new SupervisorError("unavailable", "no live supervisor heartbeat")
    }
  } catch (error) {
    await nc.close()
    if (error instanceof SupervisorError) throw error
    throw new SupervisorError("unavailable", `supervisor heartbeat unreadable: ${(error as Error).message}`)
  }
  return {
    async request<T>(operation: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
      let reply: { ok: boolean; data?: T; error?: { code: string; message: string } }
      try {
        const msg = await nc.request(`${API_PREFIX}.${operation}`, JSON.stringify(body), { timeout: timeoutMs })
        reply = msg.json()
      } catch (error) {
        const text = (error as Error).message ?? String(error)
        const code = /no responders/i.test(text) ? "unavailable" : /timeout/i.test(text) ? "timeout" : "transport"
        throw new SupervisorError(code, `${operation}: ${text}`)
      }
      if (!reply.ok) throw new SupervisorError(reply.error?.code ?? "request_failed", reply.error?.message ?? "request failed")
      return reply.data as T
    },
    async close() {
      await nc.close()
    },
  }
}

/**
 * Submit with the same request id until acceptance is confirmed. A timeout
 * or transport error leaves acceptance uncertain, so it is retried rather
 * than treated as rejection.
 */
export async function submitWithRetry(
  client: SupervisorClient,
  requestId: string,
  spec: unknown,
  attempts = 3,
): Promise<{ batchId: string; runIds: string[] }> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.request("submit", { requestId, spec })
    } catch (error) {
      last = error
      if (!(error instanceof SupervisorError) || !["timeout", "transport"].includes(error.code)) throw error
    }
  }
  throw last
}

function localRun(runId: string): SupervisorRunState {
  const result = readJsonIfExists<RunResult>(join(runsDir(stateRoot()), runId, "result.json"))
  return { runId, state: result ? "derived" : "unknown", result }
}

/** Fetch run states, reading run files locally when a reply is too large. */
export async function fetchRuns(
  client: SupervisorClient,
  operation: "status" | "result",
  batchId: string,
  runIds: string[],
): Promise<SupervisorRunState[]> {
  try {
    const data = await client.request<{ runs: SupervisorRunState[] }>(operation, { kind: "batch", batchId })
    return data.runs
  } catch (error) {
    if (!(error instanceof SupervisorError) || error.code !== "response_too_large") throw error
  }
  const ids = runIds.length
    ? runIds
    : (readJsonIfExists<{ runIds: string[] }>(join(batchesDir(stateRoot()), `${batchId}.json`))?.runIds ?? [])
  const runs: SupervisorRunState[] = []
  for (const runId of ids) {
    try {
      const data = await client.request<{ runs: SupervisorRunState[] }>(operation, { kind: "run", runId })
      runs.push(data.runs[0])
    } catch (error) {
      if (!(error instanceof SupervisorError) || error.code !== "response_too_large") throw error
      runs.push(localRun(runId))
    }
  }
  return runs
}
