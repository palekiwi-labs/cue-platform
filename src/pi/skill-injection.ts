import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent"
import { stripFrontmatter } from "@earendil-works/pi-coding-agent"
import { readFile } from "node:fs/promises"
import { runCue } from "./lib/cue-exec"

/** Name of the foundational skill injected into every session. */
export const CUE_SKILL_NAME = "cue"

/**
 * Build the system prompt block carrying the full cue skill and the live
 * session state.
 *
 * The skill body is injected verbatim (frontmatter stripped): the protocol
 * is essential and agents reading SKILL.md through a generic read tool
 * truncate it. `status` is the raw `cue status` output, or null when it
 * could not be obtained.
 */
export function buildCueSkillBlock(
  skillBody: string,
  skillPath: string,
  status: string | null,
): string {
  const state =
    status === null || status === ""
      ? "cue status unavailable: no active context is resolved. Do not " +
        "attempt context-less writes; create a context or ask the operator."
      : status
  return [
    `<cue-skill path="${skillPath}">`,
    "The `cue` skill below is already loaded in full. Do not read its",
    "SKILL.md again; follow it as the operating protocol for cue.",
    "",
    skillBody.trim(),
    "</cue-skill>",
    "",
    "<cue-session-state>",
    state,
    "</cue-session-state>",
  ].join("\n")
}

/** Locate the cue skill among the skills pi has loaded. */
export function findCueSkill(skills: Skill[] | undefined): Skill | undefined {
  return skills?.find((s) => s.name === CUE_SKILL_NAME)
}

async function cueStatus(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  try {
    return await runCue(pi, ["status"], cwd)
  } catch {
    return null
  }
}

/**
 * Inject the full cue skill into the system prompt on every agent turn.
 *
 * `before_agent_start` runs in every pi mode (interactive, print, rpc), so
 * subagents spawned as pi processes receive it too. Rewriting the system
 * prompt per turn keeps the skill out of the message history, so it cannot
 * be compacted away. The skill is re-read each turn: edits to SKILL.md take
 * effect without a copy step or restart.
 */
export function registerCueSkillInjection(pi: ExtensionAPI): void {
  let warned = false

  pi.on("before_agent_start", async (event, ctx) => {
    const skill = findCueSkill(event.systemPromptOptions?.skills)
    let body: string | null = null
    if (skill) {
      try {
        body = stripFrontmatter(await readFile(skill.filePath, "utf8"))
      } catch {
        body = null
      }
    }

    if (!skill || body === null) {
      if (!warned && ctx.hasUI) {
        ctx.ui.notify(
          skill
            ? `cue skill could not be read: ${skill.filePath}`
            : "cue skill not loaded by pi; cue protocol not injected",
          "warning",
        )
      }
      warned = true
      return undefined
    }

    const status = await cueStatus(pi, ctx.cwd)
    const block = buildCueSkillBlock(body, skill.filePath, status)
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` }
  })
}
