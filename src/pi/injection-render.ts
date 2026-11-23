import { statSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent"
import { stripFrontmatter } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { countTokens } from "gpt-tokenizer"
import { CUE_CONTEXT_TYPE, type CueContextDetails } from "./lib/current-context"
import { buildCueSkillBlock } from "./skill-injection"

export interface InjectionSection {
  label: string
  tokens: number
}

export interface InjectionSummary {
  address?: string
  kind?: string
  mode?: string
  sections: InjectionSection[]
  total: number
}

const BAR_WIDTH = 16
const LABELS: Record<string, string> = {
  identity: "identity",
  "context-body": "context body",
  documents: "documents",
  handoff: "hand-off",
  "recent-artifacts": "recent artifacts",
}

function sectionLabel(tag: string, attrs: string, body: string): string {
  if (tag === "log") {
    const latest = /latest="(\d+)"/.exec(attrs)?.[1]
    const total = /total="(\d+)"/.exec(attrs)?.[1]
    return latest && total ? `log (${latest} of ${total})` : "log"
  }
  if (tag === "tasks") {
    const n = body.split("\n").filter((l) => l.trim() !== "").length
    return `tasks (${n})`
  }
  return LABELS[tag] ?? tag
}

/**
 * Split an injected cue-context message into its sections and count each
 * with the o200k tokenizer. Text before the explore block is the session
 * preamble, loose lines inside it are misc, and text after it is the note.
 */
export function summarizeInjection(content: string): InjectionSummary {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const sections: InjectionSection[] = []
  const summary: InjectionSummary = { sections, total: 0 }
  let phase: "session" | "explore" | "note" = "session"
  let loose: string[] = []

  const flushLoose = () => {
    const text = loose.join("\n").trim()
    loose = []
    if (text === "") return
    const label = phase === "explore" ? "misc" : phase
    sections.push({ label, tokens: countTokens(text) })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const explore = /^<cue-context-explore address="([^"]*)"[^>]*>$/.exec(line)
    if (explore) {
      flushLoose()
      summary.address = explore[1]
      phase = "explore"
      continue
    }
    if (line === "</cue-context-explore>") {
      flushLoose()
      phase = "note"
      continue
    }
    const open = /^<([a-z][a-z-]*)((?: [^>]*)?)>$/.exec(line)
    const close = open ? lines.indexOf(`</${open[1]}>`, i + 1) : -1
    if (!open || close < 0) {
      loose.push(line)
      continue
    }
    flushLoose()
    const tag = open[1]!
    const body = lines.slice(i + 1, close).join("\n")
    if (tag === "identity") {
      summary.kind = /^kind: (.+)$/m.exec(body)?.[1]
      summary.mode = /^mode: (.+)$/m.exec(body)?.[1]
    }
    const block = lines.slice(i, close + 1).join("\n")
    sections.push({ label: sectionLabel(tag, open[2] ?? "", body), tokens: countTokens(block) })
    i = close
  }
  flushLoose()
  summary.total = countTokens(content)
  return summary
}

const PACKAGE_SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/cue/SKILL.md")
let skillCache: { path: string; mtimeMs: number; tokens: number } | undefined

/**
 * Tokens of the cue skill block the system prompt carries on every turn,
 * measured from the skill file with an empty session state.
 */
export function skillBlockTokens(path = PACKAGE_SKILL): number | undefined {
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (skillCache?.path === path && skillCache.mtimeMs === mtimeMs) return skillCache.tokens
    const body = stripFrontmatter(readFileSync(path, "utf8"))
    const tokens = countTokens(buildCueSkillBlock(body, path, ""))
    skillCache = { path, mtimeMs, tokens }
    return tokens
  } catch {
    return undefined
  }
}

export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

function bar(tokens: number, max: number): string {
  if (max <= 0) return ""
  const eighths = Math.max(1, Math.round((tokens / max) * BAR_WIDTH * 8))
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return "█".repeat(full) + (part ? " ▏▎▍▌▋▊▉"[part]! : "")
}

/** Lines of the collapsed view, without the expand hint. */
export function collapsedLines(
  theme: Theme,
  summary: InjectionSummary,
  skillTokens: number | undefined,
): string[] {
  const tags = [summary.kind, summary.mode].filter(Boolean).join(" · ")
  const head =
    theme.fg("accent", theme.bold("cue context")) +
    (summary.address ? `  ${summary.address}` : "") +
    (tags ? theme.fg("muted", `  ${tags}`) : "")
  const totals =
    `~${fmtTok(summary.total)} tokens injected` +
    (skillTokens === undefined
      ? ""
      : theme.fg("muted", `  ·  cue skill in system prompt ~${fmtTok(skillTokens)} every turn`))
  const width = Math.max(0, ...summary.sections.map((s) => s.label.length))
  const max = Math.max(0, ...summary.sections.map((s) => s.tokens))
  const rows = summary.sections.map(
    (s) =>
      `  ${s.label.padEnd(width)}  ${fmtTok(s.tokens).padStart(6)}  ` +
      theme.fg("dim", bar(s.tokens, max)),
  )
  return [head, totals, ...rows]
}

type HintOptions = { keyHint?: (keybinding: string, description: string) => string }

function contentText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n")
}

/**
 * Render cue-context injections collapsed to a token breakdown; the
 * expand key shows the full injected text.
 */
export function registerInjectionRenderer(pi: ExtensionAPI): void {
  const cache = new Map<string, InjectionSummary>()
  pi.registerMessageRenderer<CueContextDetails>(
    CUE_CONTEXT_TYPE,
    (message, options: MessageRenderOptions, theme) => {
      const text = contentText(message.content)
      let summary = cache.get(text)
      if (!summary) {
        summary = summarizeInjection(text)
        if (!summary.address && message.details?.address) summary.address = message.details.address
        if (cache.size > 64) cache.clear()
        cache.set(text, summary)
      }
      const lines = collapsedLines(theme, summary, skillBlockTokens())
      if (options.expanded) {
        lines.push("", text)
      } else {
        const hint = (options as HintOptions).keyHint?.("app.tools.expand", "to expand") ?? "expand to see the full text"
        lines.push(theme.fg("dim", `  ${hint}`))
      }
      return new Text(lines.join("\n"), options.outputPad, 0)
    },
  )
}
