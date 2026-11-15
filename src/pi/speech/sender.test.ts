import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { FakeBridge } from "./fake-bridge"
import { post, SpeechSender } from "./sender"

let bridge: FakeBridge
let url: string
let failures: string[]

const sender = (timeoutMs = 300) => new SpeechSender({ url, timeoutMs, onFailure: (r) => failures.push(r) })

beforeEach(async () => {
  bridge = new FakeBridge()
  url = await bridge.start()
  failures = []
})

afterEach(() => bridge.stopped())

describe("SpeechSender", () => {
  test("sends sentences one at a time, in order", async () => {
    bridge.holdSay = true
    const s = sender()
    s.say(["one", "two"])
    s.say(["three"])
    await bridge.received(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(bridge.paths()).toEqual(["/say one"])
    bridge.holdSay = false
    bridge.release()
    await s.settled()
    expect(bridge.paths()).toEqual(["/say one", "/say two", "/say three"])
    expect(failures).toEqual([])
    expect(s.used).toBe(true)
  })

  test("stop drops pending sentences and reaches the bridge without waiting", async () => {
    bridge.holdSay = true
    const s = sender()
    s.say(["one", "two", "three"])
    await bridge.received(1)
    await s.stop()
    expect(bridge.paths()).toEqual(["/say one", "/stop"])
    bridge.release()
    await s.settled()
    expect(bridge.paths()).toEqual(["/say one", "/stop", "/stop"])
  })

  test("a stop with nothing in flight is sent once", async () => {
    const s = sender()
    expect(s.used).toBe(false)
    await s.stop()
    await s.settled()
    expect(bridge.paths()).toEqual(["/stop"])
  })

  test("a double stop during a flight sends one trailing stop", async () => {
    bridge.holdSay = true
    const s = sender()
    s.say(["one", "two"])
    await bridge.received(1)
    await Promise.all([s.stop(), s.stop()])
    bridge.release()
    await s.settled()
    expect(bridge.paths()).toEqual(["/say one", "/stop", "/stop", "/stop"])
  })

  test("the next message waits for the trailing stop", async () => {
    bridge.holdSay = true
    const s = sender()
    s.say(["one", "two"])
    await bridge.received(1)
    await s.stop()
    s.say(["next"])
    bridge.holdSay = false
    bridge.release()
    await s.settled()
    expect(bridge.paths()).toEqual(["/say one", "/stop", "/stop", "/say next"])
  })

  test("a refused /say drops the rest of its message but not the next one", async () => {
    bridge.sayStatus = 503
    const s = sender()
    s.say(["a1", "a2", "a3"])
    await s.settled()
    expect(bridge.paths()).toEqual(["/say a1"])
    expect(failures).toEqual(["HTTP 503"])
    bridge.sayStatus = 202
    s.say(["b1", "b2"])
    await s.settled()
    expect(bridge.paths()).toEqual(["/say a1", "/say b1", "/say b2"])
    expect(failures).toEqual(["HTTP 503"])
  })

  test("an unreachable bridge fails each message once and never throws", async () => {
    const closed = new FakeBridge()
    const closedUrl = await closed.start()
    await closed.stopped()
    const s = new SpeechSender({ url: closedUrl, timeoutMs: 300, onFailure: (r) => failures.push(r) })
    s.say(["a1", "a2"])
    s.say(["b1"])
    await s.settled()
    await s.stop()
    expect(failures.length).toBe(2)
  })

  test("a bridge that never answers times out", async () => {
    bridge.holdSay = true
    const s = sender(50)
    const started = Date.now()
    s.say(["one", "two"])
    await s.settled()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(bridge.paths()).toEqual(["/say one"])
    expect(failures).toEqual(["no answer within 50 ms"])
  })
})

describe("post", () => {
  let server: Server
  let base: string
  let seen: { body: string; type?: string }[]

  beforeEach(async () => {
    seen = []
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        seen.push({ body, type: req.headers["content-type"] })
        res.writeHead(202).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  test("posts a JSON body and reports 2xx as ok", async () => {
    expect(await post(base, "/say", JSON.stringify({ text: "hi" }))).toEqual({ ok: true })
    expect(seen).toEqual([{ body: '{"text":"hi"}', type: "application/json" }])
  })

  test("reports a malformed URL as a failure instead of throwing", async () => {
    const result = await post("not a url", "/say", "{}")
    expect(result.ok).toBe(false)
  })
})
