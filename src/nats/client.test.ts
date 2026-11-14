import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, Socket } from "node:net"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { createNatsClient, DEFAULT_NATS_URL, resolveNatsUrl, type NatsClient } from "./client"

const natsServerBin = Bun.which("nats-server")

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket()
    sock.once("connect", () => {
      sock.destroy()
      resolve(true)
    })
    sock.once("error", () => resolve(false))
    sock.connect(port, "127.0.0.1")
  })
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error("condition not met in time")
}

const servers: ChildProcess[] = []
const clients: NatsClient[] = []
const subscribers: NatsConnection[] = []

async function startServer(port: number): Promise<ChildProcess> {
  const proc = spawn(natsServerBin!, ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" })
  servers.push(proc)
  await waitFor(() => portOpen(port))
  return proc
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise((resolve) => proc.once("exit", resolve))
  proc.kill("SIGKILL")
  await exited
}

function client(port: number): NatsClient {
  const c = createNatsClient({
    url: `nats://127.0.0.1:${port}`,
    connectTimeoutMs: 500,
    reconnectTimeWaitMs: 100,
    retryInitialMs: 50,
    retryMaxMs: 200,
  })
  clients.push(c)
  return c
}

async function subscriber(port: number, subject: string) {
  const nc = await connect({ servers: `nats://127.0.0.1:${port}` })
  subscribers.push(nc)
  const received: string[] = []
  nc.subscribe(subject, {
    callback: (_err, msg) => {
      received.push(msg.string())
    },
  })
  await nc.flush()
  return received
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(subscribers.splice(0).map((nc) => nc.close().catch(() => undefined)))
  await Promise.all(servers.splice(0).map(stopServer))
})

describe("resolveNatsUrl", () => {
  test("defaults to the local server", () => {
    expect(resolveNatsUrl({})).toBe(DEFAULT_NATS_URL)
    expect(resolveNatsUrl({ CUE_NATS_URL: "  " })).toBe(DEFAULT_NATS_URL)
  })

  test("honours CUE_NATS_URL", () => {
    expect(resolveNatsUrl({ CUE_NATS_URL: "nats://hub:4222" })).toBe("nats://hub:4222")
  })
})

describe("without a server", () => {
  test("stays idle until first use", async () => {
    const c = client(await freePort())
    expect(c.state()).toBe("idle")
    expect(c.isConnected()).toBe(false)
  })

  test("publish drops silently and retries without unhandled rejections", async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    try {
      const c = client(await freePort())
      expect(c.publish("agent.test", { a: 1 })).toBe(false)
      expect(c.publish("agent.test", "text")).toBe(false)
      expect(c.state()).toBe("connecting")
      expect(c.dropped()).toBe(2)
      await Bun.sleep(400)
      expect(c.isConnected()).toBe(false)
      expect(rejections).toEqual([])
      await c.close()
      expect(c.state()).toBe("closed")
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })

  test("close is safe when never started and keeps the client inert", async () => {
    const c = client(await freePort())
    await c.close()
    await c.close()
    expect(c.state()).toBe("closed")
    expect(c.publish("agent.test", {})).toBe(false)
    expect(c.state()).toBe("closed")
  })
})

describe.skipIf(!natsServerBin)("with nats-server", () => {
  test("publishes JSON, strings and bytes", async () => {
    const port = await freePort()
    await startServer(port)
    const received = await subscriber(port, "agent.>")
    const c = client(port)
    c.start()
    await waitFor(() => c.isConnected())

    expect(c.publish("agent.turn", { turn: 1, ok: true })).toBe(true)
    expect(c.publish("agent.text", "hello")).toBe(true)
    expect(c.publish("agent.bytes", new TextEncoder().encode("raw"))).toBe(true)
    await waitFor(() => received.length === 3)

    expect(JSON.parse(received[0])).toEqual({ turn: 1, ok: true })
    expect(received.slice(1)).toEqual(["hello", "raw"])
  })

  test("drops unencodable data without throwing", async () => {
    const port = await freePort()
    await startServer(port)
    const c = client(port)
    c.start()
    await waitFor(() => c.isConnected())
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(c.publish("agent.bad", cyclic)).toBe(false)
    expect(c.publish("bad subject", {})).toBe(false)
    expect(c.dropped()).toBe(2)
    expect(c.isConnected()).toBe(true)
  })

  test("connects and resumes publishing when the server starts late", async () => {
    const port = await freePort()
    const c = client(port)
    expect(c.publish("agent.early", {})).toBe(false)
    await Bun.sleep(150)

    await startServer(port)
    await waitFor(() => c.isConnected())
    const received = await subscriber(port, "agent.late")
    expect(c.publish("agent.late", { n: 1 })).toBe(true)
    await waitFor(() => received.length === 1)
    expect(JSON.parse(received[0])).toEqual({ n: 1 })
  })

  test("reconnects after a server restart", async () => {
    const port = await freePort()
    const first = await startServer(port)
    const c = client(port)
    c.start()
    await waitFor(() => c.isConnected())

    await stopServer(first)
    await waitFor(() => c.state() === "reconnecting")
    expect(c.publish("agent.down", {})).toBe(false)

    await startServer(port)
    await waitFor(() => c.isConnected())
    const received = await subscriber(port, "agent.up")
    expect(c.publish("agent.up", "back")).toBe(true)
    await waitFor(() => received.length === 1)
    expect(received).toEqual(["back"])
  })

  test("close drains a live connection", async () => {
    const port = await freePort()
    await startServer(port)
    const received = await subscriber(port, "agent.final")
    const c = client(port)
    c.start()
    await waitFor(() => c.isConnected())
    c.publish("agent.final", "bye")
    await c.close()
    expect(c.state()).toBe("closed")
    await waitFor(() => received.length === 1)
  })
})
