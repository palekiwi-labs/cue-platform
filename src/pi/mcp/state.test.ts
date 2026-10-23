import { describe, expect, test } from "bun:test"
import { Backoff } from "./state"

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe("Backoff", () => {
  test("is ready before any failure", () => {
    const c = clock()
    expect(new Backoff(5000, 60000, c.now).ready()).toBe(true)
  })

  test("waits the initial delay after the first failure", () => {
    const c = clock()
    const b = new Backoff(5000, 60000, c.now)
    b.failure()
    expect(b.ready()).toBe(false)
    c.advance(4999)
    expect(b.ready()).toBe(false)
    c.advance(1)
    expect(b.ready()).toBe(true)
  })

  test("doubles the delay on each failure up to the maximum", () => {
    const c = clock()
    const b = new Backoff(5000, 12000, c.now)
    b.failure()
    b.failure()
    c.advance(9999)
    expect(b.ready()).toBe(false)
    c.advance(1)
    expect(b.ready()).toBe(true)
    b.failure()
    c.advance(12000)
    expect(b.ready()).toBe(true)
  })

  test("reset makes it ready and restarts from the initial delay", () => {
    const c = clock()
    const b = new Backoff(5000, 60000, c.now)
    b.failure()
    b.failure()
    b.reset()
    expect(b.ready()).toBe(true)
    b.failure()
    c.advance(5000)
    expect(b.ready()).toBe(true)
  })
})
