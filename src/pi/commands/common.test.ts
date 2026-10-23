import { describe, expect, test } from "bun:test"
import { withoutCueSkillLoad } from "./common"

describe("withoutCueSkillLoad", () => {
  test("drops a sole cue load line and its blank separator", () => {
    expect(withoutCueSkillLoad("Load the `cue` skill.\n\n**Mandatory**")).toBe(
      "**Mandatory**",
    )
  })

  test("keeps the mode skill from a pair", () => {
    expect(withoutCueSkillLoad("Load the `cue` and `cue-design` skills.\n\nX")).toBe(
      "Load the `cue-design` skill.\n\nX",
    )
  })

  test("keeps the remaining skills from a list", () => {
    expect(
      withoutCueSkillLoad(
        "Load the `cue`, `cue-build`, `git-commit` and `tdd` skills.\n\nX",
      ),
    ).toBe("Load the `cue-build`, `git-commit` and `tdd` skills.\n\nX")
  })

  test("leaves prompts without a cue load untouched", () => {
    const idea = "Load the `cue-idea` skill and follow it for the idea in `<idea>`."
    expect(withoutCueSkillLoad(idea)).toBe(idea)
    expect(withoutCueSkillLoad("Load the `cue-idea` skill.\nX")).toBe(
      "Load the `cue-idea` skill.\nX",
    )
  })

  test("only rewrites the leading line", () => {
    const p = "Intro\nLoad the `cue` skill."
    expect(withoutCueSkillLoad(p)).toBe(p)
  })
})
