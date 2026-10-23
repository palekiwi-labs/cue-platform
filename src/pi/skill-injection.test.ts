import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCueSkillBlock,
  findCueSkill,
  registerCueSkillInjection,
} from "./skill-injection"

type Handler = (event: any, ctx: any) => Promise<any>

function setup(statusCode = 0) {
  let handler: Handler | undefined
  const notes: string[] = []
  const pi = {
    on: (name: string, h: Handler) => {
      if (name === "before_agent_start") handler = h
    },
    exec: async () => ({
      stdout: statusCode === 0 ? "active context: demo\n  kind: work\n" : "",
      stderr: statusCode === 0 ? "" : "Error: no context",
      code: statusCode,
      killed: false,
    }),
  } as unknown as ExtensionAPI
  registerCueSkillInjection(pi)
  const ctx = {
    cwd: "/work",
    hasUI: true,
    ui: { notify: (m: string) => notes.push(m) },
  }
  return { run: (event: any) => handler!(event, ctx), notes }
}

function skillFile(content: string): Skill {
  const dir = mkdtempSync(join(tmpdir(), "cue-skill-"))
  const filePath = join(dir, "SKILL.md")
  writeFileSync(filePath, content)
  return { name: "cue", filePath, baseDir: dir } as unknown as Skill
}

const SKILL = "---\nname: cue\ndescription: d\n---\n\n# cue\n\nFull body line.\n"

describe("buildCueSkillBlock", () => {
  test("wraps the body and appends status", () => {
    const b = buildCueSkillBlock("# cue\nbody", "/s/SKILL.md", "active: x")
    expect(b).toContain('<cue-skill path="/s/SKILL.md">')
    expect(b).toContain("# cue\nbody\n</cue-skill>")
    expect(b).toContain("<cue-session-state>\nactive: x\n</cue-session-state>")
  })

  test("explains an unresolved context", () => {
    const b = buildCueSkillBlock("x", "/p", null)
    expect(b).toContain("no active context")
  })
})

describe("findCueSkill", () => {
  test("matches by name only", () => {
    const skills = [{ name: "cue-design" }, { name: "cue" }] as Skill[]
    expect(findCueSkill(skills)?.name).toBe("cue")
    expect(findCueSkill(undefined)).toBeUndefined()
  })
})

describe("before_agent_start injection", () => {
  test("appends the full skill body without frontmatter", async () => {
    const { run } = setup()
    const out = await run({
      systemPrompt: "BASE",
      systemPromptOptions: { skills: [skillFile(SKILL)] },
    })
    expect(out.systemPrompt.startsWith("BASE\n\n<cue-skill")).toBe(true)
    expect(out.systemPrompt).toContain("Full body line.")
    expect(out.systemPrompt).not.toContain("description: d")
    expect(out.systemPrompt).toContain("active context: demo")
  })

  test("still injects the skill when cue status fails", async () => {
    const { run } = setup(1)
    const out = await run({
      systemPrompt: "BASE",
      systemPromptOptions: { skills: [skillFile(SKILL)] },
    })
    expect(out.systemPrompt).toContain("Full body line.")
    expect(out.systemPrompt).toContain("no active context")
  })

  test("warns once and leaves the prompt alone when the skill is missing", async () => {
    const { run, notes } = setup()
    const event = { systemPrompt: "BASE", systemPromptOptions: { skills: [] } }
    expect(await run(event)).toBeUndefined()
    expect(await run(event)).toBeUndefined()
    expect(notes).toHaveLength(1)
  })

  test("warns when the skill file cannot be read", async () => {
    const { run, notes } = setup()
    const skill = { name: "cue", filePath: "/nonexistent/SKILL.md" } as Skill
    const out = await run({
      systemPrompt: "BASE",
      systemPromptOptions: { skills: [skill] },
    })
    expect(out).toBeUndefined()
    expect(notes[0]).toContain("/nonexistent/SKILL.md")
  })
})
