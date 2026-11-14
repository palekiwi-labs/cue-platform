import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const natsServerBin = Bun.which("nats-server")

export function freePort(): Promise<number> {
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

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error("condition not met in time")
}

export interface TestServer {
  port: number
  url: string
  stop(): Promise<void>
}

/** Start a throwaway JetStream-enabled nats-server on a free port. */
export async function startJetStreamServer(): Promise<TestServer> {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), "nats-js-"))
  const proc: ChildProcess = spawn(natsServerBin!, ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", dir], {
    stdio: "ignore",
  })
  await waitFor(() => portOpen(port))
  return {
    port,
    url: `nats://127.0.0.1:${port}`,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise((resolve) => proc.once("exit", resolve))
        proc.kill("SIGKILL")
        await exited
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
