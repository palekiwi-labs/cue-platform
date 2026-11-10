import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { contextRecency } from "./context-recency"

export type Exec = Pick<ExtensionAPI, "exec">

export const DETAILS = ["identity", "brief", "working"] as const
export type Detail = (typeof DETAILS)[number]

const LOG_TAIL: Record<Detail, number> = { identity: 0, brief: 3, working: 10 }
const DOC_MAX_LINES = 300
const OPEN = new Set(["open", "in-progress"])
const PRIORITY_ORDER = ["critical", "high", "normal", "low"]

export class ExploreError extends Error {}

interface ContextRecord {
  context: string
  scope: string
  title?: string | null
  kind?: string | null
  mode?: string | null
  description?: string | null
  archived_at?: number | null
  parent?: string | null
  refs?: string[] | null
}

interface ArtifactRecord {
  path: string
  name: string
  type: string
  frontmatter?: Record<string, unknown>
}

interface LogRecord {
  timestamp: number
  trace?: string | null
}

export function parseDetail(value: string | undefined): Detail {
  if (value === undefined) return "brief"
  if ((DETAILS as readonly string[]).includes(value)) return value as Detail
  throw new ExploreError(
    `invalid detail "${value}"; valid values: ${DETAILS.join(", ")}`,
  )
}

export function parseContextAddress(value: string): string {
  const parts = value.trim().replace(/^\/+|\/+$/g, "").split("/")
  if (parts.length === 3 && parts.every((p) => p !== "" && !/\s/.test(p))) {
    return parts.join("/")
  }
  throw new ExploreError(
    `"${value}" is not a context address <org>/<repo>/<context>; ` +
      "for an artifact address, explore its context and read the artifact",
  )
}

/** Body of a markdown file without its leading YAML frontmatter. */
export function stripFrontmatter(text: string): string {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  if (!t.startsWith("---\n")) return t.trim()
  const end = t.indexOf("\n---", 3)
  if (end < 0) return t.trim()
  const after = t.indexOf("\n", end + 4)
  return after < 0 ? "" : t.slice(after + 1).trim()
}

async function cue(pi: Exec, cwd: string, args: string[]): Promise<string> {
  const r = await pi.exec("cue", args, { cwd })
  if (r.code !== 0) {
    throw new ExploreError(r.stderr.trim() || `cue ${args[0]} failed`)
  }
  return r.stdout
}

async function cueJson<T>(pi: Exec, cwd: string, args: string[], fallback: T): Promise<T> {
  try {
    return JSON.parse((await cue(pi, cwd, args)) || "null") ?? fallback
  } catch {
    return fallback
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

const addressOf = (c: ContextRecord) => `${c.scope}/${c.context}`

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  return typeof v === "string" && v !== "" ? [v] : []
}

function linkLine(address: string, byAddress: Map<string, ContextRecord>): string {
  const c = byAddress.get(address)
  if (!c) return `  - ${address}`
  const kind = c.kind ? ` [${c.kind}]` : ""
  return `  - ${address}${kind}${c.title ? `  ${c.title}` : ""}`
}

function identityBlock(
  address: string,
  self: ContextRecord,
  children: ContextRecord[],
  byAddress: Map<string, ContextRecord>,
): string {
  const lines = [`address: ${address}`]
  if (self.title) lines.push(`title: ${self.title}`)
  if (self.kind) lines.push(`kind: ${self.kind}`)
  if (self.mode) lines.push(`mode: ${self.mode}`)
  if (self.description) lines.push(`description: ${self.description}`)
  if (self.archived_at) lines.push("archived: yes")
  if (self.parent) lines.push("parent:", linkLine(self.parent, byAddress))
  const refs = asList(self.refs)
  if (refs.length > 0) {
    lines.push("refs:", ...refs.map((r) => linkLine(r, byAddress)))
  }
  if (children.length > 0) {
    lines.push(
      `children (${children.length}):`,
      ...children.map((c) => linkLine(addressOf(c), byAddress)),
    )
  }
  return `<identity>\n${lines.join("\n")}\n</identity>`
}

function artifactAddress(address: string, a: ArtifactRecord): string {
  return `${address}/${a.type}/${a.name}`
}

function tasksBlock(address: string, artifacts: ArtifactRecord[]): string {
  const rank = (p: unknown) => {
    const i = PRIORITY_ORDER.indexOf(String(p ?? "normal"))
    return i < 0 ? PRIORITY_ORDER.length : i
  }
  const tasks = artifacts
    .filter((a) => a.type === "task")
    .filter((a) => {
      const s = String(a.frontmatter?.status ?? "open")
      return s !== "complete" && s !== "closed"
    })
    .sort(
      (a, b) =>
        rank(a.frontmatter?.priority) - rank(b.frontmatter?.priority) ||
        a.name.localeCompare(b.name),
    )
  if (tasks.length === 0) return ""
  const lines = tasks.map((t) => {
    const fm = t.frontmatter ?? {}
    const title = fm.title ? `  ${String(fm.title)}` : ""
    return `${String(fm.status ?? "open")}  ${String(fm.priority ?? "normal")}  ${artifactAddress(address, t)}${title}`
  })
  return `<tasks outstanding>\n${lines.join("\n")}\n</tasks>`
}

async function logBlock(
  pi: Exec,
  cwd: string,
  address: string,
  total: number,
  limit: number,
): Promise<string> {
  if (total === 0) return ""
  let md = ""
  try {
    md = (await cue(pi, cwd, [
      "log", "list", "--context", address, "--format", "md", "--limit", String(limit),
    ])).trim()
  } catch {
    return ""
  }
  const older = total - Math.min(total, limit)
  const note = older > 0
    ? `\n\n${older} older entries omitted: cue log list --context ${address} --format md`
    : ""
  return `<log latest="${Math.min(total, limit)}" total="${total}">\n${md}${note}\n</log>`
}

interface Handoff {
  address: string
  path: string
  since: number
}

interface Documents {
  specs: ArtifactRecord[]
  masterPlan?: ArtifactRecord
  openPlans: ArtifactRecord[]
  handoff?: Handoff
}

const isHandoff = (a: ArtifactRecord) =>
  a.type === "trace" && (a.name.split("/").pop() ?? "").startsWith("handoff")

const createdAt = (a: ArtifactRecord) => Number(a.frontmatter?.created_at ?? 0)

function latestHandoff(
  address: string,
  artifacts: ArtifactRecord[],
  logs: LogRecord[],
): Handoff | undefined {
  const trace = artifacts
    .filter(isHandoff)
    .sort((a, b) => createdAt(b) - createdAt(a) || b.name.localeCompare(a.name))[0]
  if (!trace) return undefined
  const handoffAddress = artifactAddress(address, trace)
  const attached = logs.find((l) => l.trace === handoffAddress)
  const cutoff = attached ? attached.timestamp : createdAt(trace) * 1e9
  return {
    address: handoffAddress,
    path: trace.path,
    since: logs.filter((l) => l.timestamp > cutoff).length,
  }
}

function selectDocuments(
  address: string,
  artifacts: ArtifactRecord[],
  logs: LogRecord[],
): Documents {
  const byName = (a: ArtifactRecord, b: ArtifactRecord) => a.name.localeCompare(b.name)
  const plans = artifacts.filter((a) => a.type === "plan")
  return {
    specs: artifacts.filter((a) => a.type === "spec").sort(byName),
    masterPlan: plans.find((p) => p.name === "index.md"),
    openPlans: plans
      .filter((p) => p.name !== "index.md")
      .filter((p) => OPEN.has(String(p.frontmatter?.status ?? "open")))
      .sort(byName),
    handoff: latestHandoff(address, artifacts, logs),
  }
}

function documentsIndex(address: string, docs: Documents): string {
  const lines: string[] = []
  for (const s of docs.specs) lines.push(`spec: ${artifactAddress(address, s)}`)
  if (docs.masterPlan) {
    lines.push(`master plan: ${artifactAddress(address, docs.masterPlan)}`)
  }
  for (const p of docs.openPlans) {
    lines.push(`open plan: ${artifactAddress(address, p)}`)
  }
  if (docs.handoff) {
    lines.push(
      `latest hand-off: ${docs.handoff.address} (${docs.handoff.since} log entries since)`,
    )
  }
  if (lines.length === 0) return ""
  return `<documents>\n${lines.join("\n")}\n</documents>`
}

async function handoffBlock(handoff: Handoff): Promise<string> {
  const attrs = `address="${handoff.address}" entries-since="${handoff.since}"`
  const text = await readText(handoff.path)
  if (text === undefined) return `<handoff ${attrs} missing="true"></handoff>`
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n")
  if (lines.length <= DOC_MAX_LINES) {
    return `<handoff ${attrs}>\n${lines.join("\n")}\n</handoff>`
  }
  const shown = lines.slice(0, DOC_MAX_LINES).join("\n")
  return (
    `<handoff ${attrs} truncated="true">\n${shown}\n` +
    `[truncated: ${lines.length - DOC_MAX_LINES} more lines; read ${handoff.address}]\n</handoff>`
  )
}

function footer(store: string): string {
  return (
    `Read an artifact at ${store}/<address>. Linked contexts are not ` +
    "expanded: explore one with cue-context-explore <address>."
  )
}

/**
 * Describe one context at the given detail. Linked contexts are listed
 * with titles and activity counts, never expanded. Output depends only on
 * the store and the address, not on the calling session.
 */
export async function exploreContext(
  pi: Exec,
  cwd: string,
  rawAddress: string,
  detail: Detail = "brief",
  nowMs = Date.now(),
): Promise<string> {
  const address = parseContextAddress(rawAddress)
  const status = await cueJson<{ store?: string }>(
    pi, cwd, ["status", "--context", address, "--json"], {},
  )
  const contexts = await cueJson<ContextRecord[]>(
    pi, cwd, ["context", "list", "--scope", "store", "--archived", "--json"], [],
  )
  const byAddress = new Map(contexts.map((c) => [addressOf(c), c]))
  const self = byAddress.get(address)
  if (!self || !status.store) {
    throw new ExploreError(`no such context ${address}`)
  }
  const store = status.store
  const children = contexts
    .filter((c) => c.parent === address)
    .sort((a, b) => addressOf(a).localeCompare(addressOf(b)))

  const sections = [identityBlock(address, self, children, byAddress)]
  if (detail !== "identity") {
    const [body, recency, artifacts, logs] = await Promise.all([
      readText(join(store, address, "context.md")),
      contextRecency(pi, cwd, address, nowMs),
      cueJson<ArtifactRecord[]>(
        pi, cwd, ["list", "--context", address, "--frontmatter"], [],
      ),
      cueJson<LogRecord[]>(pi, cwd, ["log", "list", "--context", address], []),
    ])
    const bodyText = body === undefined ? "" : stripFrontmatter(body)
    const docs = selectDocuments(address, artifacts, logs)
    sections.push(
      bodyText ? `<context-body address="${address}">\n${bodyText}\n</context-body>` : "",
      documentsIndex(address, docs),
      detail === "working" && docs.handoff ? await handoffBlock(docs.handoff) : "",
      footer(store),
      await logBlock(pi, cwd, address, logs.length, LOG_TAIL[detail]),
      recency.artifacts,
      recency.recency,
      tasksBlock(address, artifacts),
    )
  } else {
    sections.push(footer(store))
  }
  const inner = sections.filter((s) => s !== "").join("\n\n")
  return `<cue-context-explore address="${address}" detail="${detail}">\n${inner}\n</cue-context-explore>`
}
