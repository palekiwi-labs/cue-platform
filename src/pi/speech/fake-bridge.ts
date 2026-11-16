import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface BridgeRequest {
  path: string
  text?: string
  body?: unknown
}

/** A local stand-in for the host speech bridge, for tests. */
export class FakeBridge {
  readonly requests: BridgeRequest[] = []
  /** Status answered to /say. */
  sayStatus = 202
  /** When set, /say answers only after release(). */
  holdSay = false
  private held: (() => void)[] = []
  private readonly server = createServer((req, res) => this.handle(req, res))

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stopped(): Promise<void> {
    this.release()
    this.server.closeAllConnections()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  /** Answer every held /say. */
  release(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  /** Resolves once count requests arrived. */
  async received(count: number): Promise<void> {
    while (this.requests.length < count) await new Promise((r) => setTimeout(r, 2))
  }

  paths(): string[] {
    return this.requests.map((r) => (r.text === undefined ? r.path : `${r.path} ${r.text}`))
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const path = req.url ?? ""
      if (path === "/say") {
        const parsed = JSON.parse(body) as { text: string }
        this.requests.push({ path, text: parsed.text, body: parsed })
        const answer = () => res.writeHead(this.sayStatus).end()
        if (this.holdSay) this.held.push(answer)
        else answer()
      } else {
        this.requests.push({ path })
        res.writeHead(204).end()
      }
    })
  }
}
