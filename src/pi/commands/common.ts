import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"

/**
 * Run a `cue` subcommand best-effort, returning stdout or a fallback
 * string on failure. Mirrors the `2>/dev/null` guards in the opencode
 * command markdown: orientation gathering must never throw.
 */
export async function cueBestEffort(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  fallback = "",
): Promise<string> {
  try {
    const r = await pi.exec("cue", args, { cwd })
    return r.code === 0 ? r.stdout.trim() : fallback
  } catch {
    return fallback
  }
}

/**
 * Deliver a composed prompt as a user message. When the agent is
 * streaming, queue it as a follow-up so it lands after the current turn
 * instead of steering mid-flight.
 */
export function sendPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  content: string,
): void {
  if (!ctx.isIdle()) {
    pi.sendUserMessage(content, { deliverAs: "followUp" })
  } else {
    pi.sendUserMessage(content)
  }
}

/**
 * Join non-empty sections with blank separators, mirroring the blank
 * lines between blocks in the opencode command markdown.
 */
export function composeMessage(sections: string[]): string {
  return sections.filter((s) => s !== "").join("\n\n")
}

/**
 * Remove the instruction to load the foundational `cue` skill from a
 * command prompt shared with opencode. In pi the full skill is injected
 * into every session's system prompt (see ../skill-injection.ts), so the
 * instruction would only trigger a redundant, often truncated, read.
 *
 * Only the leading `Load the ...` line is rewritten, and only the `cue`
 * entry is dropped from it; other skills (`cue-build`, `tdd`, ...) stay.
 * When `cue` was the sole skill the line and its blank separator go.
 */
export function withoutCueSkillLoad(prompt: string): string {
  const nl = prompt.indexOf("\n")
  const first = nl < 0 ? prompt : prompt.slice(0, nl)
  const rest = nl < 0 ? "" : prompt.slice(nl + 1)
  const m = /^Load the (.+) skills?\.$/.exec(first)
  if (!m) return prompt
  const names = m[1]!.split(/, | and /)
  const kept = names.filter((n) => n !== "`cue`")
  if (kept.length === names.length) return prompt
  if (kept.length === 0) return rest.replace(/^\n+/, "")
  const list =
    kept.length === 1
      ? kept[0]
      : `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`
  const noun = kept.length === 1 ? "skill" : "skills"
  return `Load the ${list} ${noun}.${nl < 0 ? "" : "\n"}${rest}`
}
