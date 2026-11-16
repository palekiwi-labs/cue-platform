import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BACKGROUND_GUARDRAIL } from "../lib/delegate-helpers"
import { delegateTool } from "./delegate"
import { BACKEND_ENV } from "./delegate-supervisor"

describe("delegate tool on the supervisor backend", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[BACKEND_ENV]
    process.env[BACKEND_ENV] = "supervisor"
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[BACKEND_ENV]
    else process.env[BACKEND_ENV] = saved
  })

  test("background leads with the guardrail and keeps its behaviour text", () => {
    const params = delegateTool(process.cwd()).parameters as {
      properties: { background?: { description?: string } }
    }
    const description = params.properties.background?.description ?? ""
    expect(description.startsWith(BACKGROUND_GUARDRAIL)).toBe(true)
    expect(description).toContain("Return at once with the batch id")
  })
})
