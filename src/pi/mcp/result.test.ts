import { describe, expect, test } from "bun:test"
import { mapCallResult } from "./result"

const neverSave = async () => {
  throw new Error("should not save")
}

describe("mapCallResult", () => {
  test("maps text and image content and keeps the raw result as details", async () => {
    const raw = {
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    }
    const mapped = await mapCallResult("t", raw, { saveFullOutput: neverSave })
    expect(mapped.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ])
    expect(mapped.details).toEqual({ server: "cast", tool: "t", result: raw })
  })

  test("renders resources, resource links and audio as short text", async () => {
    const raw = {
      content: [
        { type: "resource", resource: { uri: "file:///a", text: "body" } },
        { type: "resource", resource: { uri: "file:///b", blob: "AA==", mimeType: "application/pdf" } },
        { type: "resource_link", uri: "file:///c", name: "c" },
        { type: "audio", data: "AA==", mimeType: "audio/wav" },
      ],
    }
    const mapped = await mapCallResult("t", raw, { saveFullOutput: neverSave })
    expect(mapped.content).toEqual([
      { type: "text", text: "[resource file:///a]\nbody" },
      { type: "text", text: "[binary resource file:///b, application/pdf]" },
      { type: "text", text: "[resource link c file:///c]" },
      { type: "text", text: "[audio audio/wav]" },
    ])
  })

  test("falls back to structured content when there is no content", async () => {
    const mapped = await mapCallResult("t", { content: [], structuredContent: { a: 1 } })
    expect(mapped.content).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }])
  })

  test("empty results say so", async () => {
    const mapped = await mapCallResult("t", { content: [] })
    expect(mapped.content).toEqual([{ type: "text", text: "(no output)" }])
  })

  test("an error result is thrown with the tool's text", async () => {
    const raw = { isError: true, content: [{ type: "text", text: "table not found" }] }
    await expect(mapCallResult("t", raw)).rejects.toThrow("table not found")
  })

  test("an error result without text names the tool", async () => {
    await expect(mapCallResult("t", { isError: true, content: [] })).rejects.toThrow(
      "MCP tool t returned an error",
    )
  })

  test("long output keeps the tail and points at the saved full output", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const saved: string[] = []
    const mapped = await mapCallResult(
      "run",
      { content: [{ type: "text", text: lines }] },
      {
        truncation: { maxLines: 3 },
        saveFullOutput: async (tool, text) => {
          saved.push(text)
          return `/tmp/${tool}.txt`
        },
      },
    )
    expect(saved).toEqual([lines])
    expect(mapped.content).toEqual([
      {
        type: "text",
        text: "line 8\nline 9\nline 10\n\n[Showing lines 8-10 of 10. Full output: /tmp/run.txt]",
      },
    ])
    expect(mapped.details.fullOutputPath).toBe("/tmp/run.txt")
    expect(mapped.details.truncation?.truncated).toBe(true)
  })

  test("byte-limited truncation names the limit", async () => {
    const text = Array.from({ length: 5 }, () => "x".repeat(10)).join("\n")
    const mapped = await mapCallResult(
      "t",
      { content: [{ type: "text", text }] },
      { truncation: { maxBytes: 25 }, saveFullOutput: async () => "/p" },
    )
    const out = (mapped.content[0] as { text: string }).text
    expect(out).toMatch(/\[Showing lines 4-5 of 5 \(25B limit\)\. Full output: \/p\]$/)
  })
})
