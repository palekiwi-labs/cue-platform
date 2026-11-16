import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BACKGROUND_GUARDRAIL } from "../lib/delegate-helpers"
import { delegateTool } from "./delegate"

const BACKEND_ENV = "CUE_DELEGATE_BACKEND"

describe("delegate tool on the cue-agent backend", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[BACKEND_ENV]
    delete process.env[BACKEND_ENV]
  })

  afterEach(() => {
    if (saved !== undefined) process.env[BACKEND_ENV] = saved
  })

  test("background leads with the guardrail and keeps its behaviour text", () => {
    const params = delegateTool(process.cwd()).parameters as {
      properties: { background?: { description?: string } }
    }
    const description = params.properties.background?.description ?? ""
    expect(description.startsWith(BACKGROUND_GUARDRAIL)).toBe(true)
    expect(description).toContain("Run the batch in a detached tmux window")
  })
})
