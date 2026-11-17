import { describe, expect, test } from "bun:test"
import { appendReply, chunkKey, replyText, TurnComments } from "./comments"

describe("TurnComments", () => {
  test("keeps one trimmed comment per chunk, replacing on save", () => {
    const c = new TurnComments()
    c.save(chunkKey(0, 1), "quote", "  first  ")
    c.save(chunkKey(0, 1), "quote", "second")
    expect(c.size).toBe(1)
    expect(c.get("0:1")).toEqual({ quote: "quote", text: "second" })
    expect(c.draft("0:1")).toBe("second")
  })

  test("orders entries by message, then chunk", () => {
    const c = new TurnComments()
    for (const key of ["10:0", "2:3", "2:10", "0:5"]) c.save(key, key, key)
    expect(c.entries().map(([k]) => k)).toEqual(["0:5", "2:3", "2:10", "10:0"])
  })

  test("deleting keeps the text for the next compose", () => {
    const c = new TurnComments()
    c.save("0:0", "q", "keep me")
    c.remove("0:0")
    expect(c.get("0:0")).toBeUndefined()
    expect(c.draft("0:0")).toBe("keep me")
    c.save("0:0", "q", "again")
    expect(c.draft("0:0")).toBe("again")
  })

  test("saving empty text deletes and keeps the old text", () => {
    const c = new TurnComments()
    c.save("0:0", "q", "old")
    c.save("0:0", "q", "   ")
    expect(c.size).toBe(0)
    expect(c.draft("0:0")).toBe("old")
  })

  test("discarded text resumes until saved; empty or unchanged text clears it", () => {
    const c = new TurnComments()
    c.save("0:0", "q", "saved")
    c.discard("0:0", "half edit")
    expect(c.draft("0:0")).toBe("half edit")
    expect(c.get("0:0")?.text).toBe("saved")
    c.discard("0:0", "saved")
    expect(c.draft("0:0")).toBe("saved")
    c.discard("0:1", "new")
    c.discard("0:1", "")
    expect(c.draft("0:1")).toBe("")
  })

  test("every change to saved comments bumps the version", () => {
    const c = new TurnComments()
    const v = c.version
    c.save("0:0", "q", "a")
    c.remove("0:0")
    c.clear()
    expect(c.version).toBe(v + 3)
    c.discard("0:0", "x")
    expect(c.version).toBe(v + 3)
  })
})

describe("replyText", () => {
  test("quotes each chunk, blank lines included, before its comment", () => {
    const c = new TurnComments()
    c.save("1:0", "later", "second note")
    c.save("0:2", "line one\n\n  indented", "first note\nsecond line")
    expect(replyText(c)).toBe("> line one\n>\n>   indented\n\nfirst note\nsecond line\n\n> later\n\nsecond note")
  })

  test("is empty without comments", () => {
    expect(replyText(new TurnComments())).toBe("")
  })
})

describe("appendReply", () => {
  test("keeps existing text and separates the reply by a blank line", () => {
    expect(appendReply("draft", "R")).toBe("draft\n\nR")
    expect(appendReply("draft\n", "R")).toBe("draft\n\nR")
    expect(appendReply("draft\n\n", "R")).toBe("draft\n\nR")
    expect(appendReply("  draft  ", "R")).toBe("  draft  \n\nR")
  })

  test("replaces an empty or blank editor", () => {
    expect(appendReply("", "R")).toBe("R")
    expect(appendReply(" \n ", "R")).toBe("R")
  })
})
