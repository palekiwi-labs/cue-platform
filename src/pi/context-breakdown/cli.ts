import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { latestSnapshot, transcriptSnapshot } from "./breakdown"
import { branchPath, parseSessionJsonl } from "./entries"
import { buildReport, formatDiff, formatReport, type Report } from "./report"
import { diffSnapshots, type Snapshot } from "./snapshot"

const USAGE = `usage: bun run context <session.jsonl | --latest [cwd]> [options]

  --latest [cwd]     newest session recorded for cwd (default: current dir)
  --json             print the report as JSON
  --compare <file>   diff the static prefix against another session
  --window <n>       context window size for percentages (default 200000)
  --turns <n|all>    turns shown in the usage table (default 20)
  --misses <n|all>   misses listed (default 15)
  --top <n>          items listed per source (default 8)`

/** Directory pi stores sessions for `cwd` in. */
export function sessionDir(cwd: string, agentDir = join(homedir(), ".pi", "agent")): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  return join(agentDir, "sessions", safe)
}

/** Newest session file for `cwd`, by modification time. */
export function latestSession(cwd: string, agentDir?: string): string | null {
  const dir = sessionDir(cwd, agentDir)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0] ?? null
}

type Args = {
  file: string | null
  latest: string | null
  json: boolean
  compare: string | null
  window: number
  turns: number | "all"
  misses: number | "all"
  top: number
}

function limit(v: string | undefined, name: string): number | "all" {
  if (v === "all") return "all"
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: expected a number or "all"`)
  return n
}

/** Parse CLI arguments. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { file: null, latest: null, json: false, compare: null, window: 200000, turns: 20, misses: 15, top: 8 }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === "--json") a.json = true
    else if (v === "--latest") {
      const next = argv[i + 1]
      a.latest = next && !next.startsWith("--") ? (i++, next) : process.cwd()
    } else if (v === "--compare") a.compare = argv[++i] ?? null
    else if (v === "--window") a.window = Number(argv[++i])
    else if (v === "--turns") a.turns = limit(argv[++i], "--turns")
    else if (v === "--misses") a.misses = limit(argv[++i], "--misses")
    else if (v === "--top") a.top = Number(argv[++i])
    else if (v === "-h" || v === "--help") throw new Error(USAGE)
    else if (v.startsWith("--")) throw new Error(`unknown option ${v}\n${USAGE}`)
    else a.file = v
  }
  if (!a.file && !a.latest) throw new Error(USAGE)
  return a
}

function load(file: string): Report {
  const parsed = parseSessionJsonl(readFileSync(file, "utf8"))
  return buildReport({ ...parsed, file })
}

function prefixOf(file: string): Snapshot | null {
  const { entries } = parseSessionJsonl(readFileSync(file, "utf8"))
  const path = branchPath(entries)
  return latestSnapshot(path) ?? transcriptSnapshot(path, null)
}

/** Run the CLI; returns the process exit code. */
export function main(argv: string[], out: (s: string) => void = console.log): number {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (e) {
    out((e as Error).message)
    return 2
  }
  const file = args.file ?? latestSession(args.latest!)
  if (!file || !existsSync(file)) {
    out(args.file ? `no such file: ${args.file}` : `no sessions under ${sessionDir(args.latest!)}`)
    return 1
  }
  const report = load(file)
  report.contextWindow = args.window
  let compare: { file: string; diff: ReturnType<typeof diffSnapshots> | null; note?: string } | null = null
  if (args.compare) {
    const a = prefixOf(args.compare)
    const b = prefixOf(file)
    compare = {
      file: args.compare,
      diff: a && b ? diffSnapshots(a, b) : null,
      ...(a && b ? {} : { note: "static prefix unknown in one of the sessions" }),
    }
  }
  if (args.json) {
    out(JSON.stringify({ ...report, compare }, null, 2))
    return 0
  }
  out(formatReport(report, { top: args.top, turns: args.turns, misses: args.misses }))
  if (compare) {
    out("")
    out(`== static prefix vs ${compare.file} ==`)
    if (!compare.diff) out(compare.note ?? "")
    else {
      const lines = formatDiff(compare.diff)
      out(compare.diff.same ? lines[0] : "cache-bust candidates (changed parts invalidate everything after them):")
      if (!compare.diff.same) for (const l of lines) out(`  ${l}`)
    }
  }
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
