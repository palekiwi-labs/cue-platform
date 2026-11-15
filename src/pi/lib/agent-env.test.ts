import { describe, expect, test } from "bun:test"
import { AGENT_NAME_ENV, withAgentName } from "./agent-env"

describe("withAgentName", () => {
  test("adds the agent name and keeps the rest of the env overlay", () => {
    expect(withAgentName({ agent: "summarizer", cwd: "/w", env: { A: "1", B: null } })).toEqual({
      agent: "summarizer",
      cwd: "/w",
      env: { A: "1", B: null, [AGENT_NAME_ENV]: "summarizer" },
    })
  })
})
