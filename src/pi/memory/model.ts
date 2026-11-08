/**
 * Data for the memory monitor: memory levels with their files, reflection
 * runs, and memory repo commits. The monitor reads everything through a
 * MemorySource, so the fake source and the real one are interchangeable.
 */

export type LevelLabel = "user" | "scope" | "coordinating"

export interface MemoryFile {
  /** Path relative to the memory repo root, e.g. `user/MEMORY.md`. */
  path: string
  content: string
}

export interface MemoryLevel {
  label: LevelLabel
  /** Directory relative to the memory repo root, e.g. `scopes/org/repo`. */
  path: string
  files: MemoryFile[]
}

export type RunState = "running" | "done"
export type RunOutcome = "committed" | "no_changes" | "failed"

export interface RunTrigger {
  kind: "cue-log" | "manual"
  /** The cue-log entry title, when a log entry triggered the run. */
  title?: string
}

export interface ReflectionRun {
  id: string
  sessionId: string
  trigger: RunTrigger
  state: RunState
  /** Undefined while the run is still going. */
  outcome?: RunOutcome
  /** Failure reason, when the run failed. */
  error?: string
  model: string
  /** Unix milliseconds. */
  started: number
  /** Seconds; undefined while running. */
  durationSecs?: number
  log: string[]
}

export interface MemoryCommit {
  hash: string
  /** Unix milliseconds. */
  time: number
  subject: string
  files: string[]
}

export interface MemorySource {
  /** Root of the memory repo, for display. */
  root: string
  /** Levels that apply to a working directory, broadest first. */
  levels(cwd: string): Promise<MemoryLevel[]>
  /** Reflection runs, newest first. */
  runs(): Promise<ReflectionRun[]>
  /** Memory repo commits, newest first. */
  commits(): Promise<MemoryCommit[]>
  /** `git show --stat --patch` of a commit; undefined when unavailable. */
  show(hash: string): Promise<string | undefined>
}

export type Tone = "live" | "ok" | "bad" | "dim"

/** One word for a run's list column: its outcome, or running. */
export function runStatus(r: ReflectionRun): string {
  if (r.state === "running") return "running"
  return r.outcome === "no_changes" ? "no changes" : (r.outcome ?? "done")
}

export function runTone(r: ReflectionRun): Tone {
  if (r.state === "running") return "live"
  if (r.outcome === "committed") return "ok"
  if (r.outcome === "failed") return "bad"
  return "dim"
}

export function triggerText(t: RunTrigger): string {
  return t.kind === "cue-log" ? `cue-log: ${t.title ?? "?"}` : "manual"
}

export function fmtDuration(secs: number | undefined): string {
  if (secs === undefined) return "-"
  if (secs < 60) return `${Math.round(secs)}s`
  return `${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, "0")}s`
}

/** Markdown detail of a run: header facts, then the log as a code block. */
export function runDetail(r: ReflectionRun): string {
  const facts = [
    `- **status:** ${runStatus(r)}`,
    `- **trigger:** ${triggerText(r.trigger)}`,
    `- **session:** \`${r.sessionId}\``,
    `- **model:** ${r.model}`,
    `- **started:** ${new Date(r.started).toISOString()}`,
    `- **duration:** ${fmtDuration(r.durationSecs)}`,
  ]
  if (r.error) facts.push(`- **error:** ${r.error}`)
  const log = r.log.length > 0 ? "```\n" + r.log.join("\n") + "\n```" : "_no log lines_"
  return `**${r.id}**\n\n${facts.join("\n")}\n\n${log}\n`
}

/** A selectable row of the memory list: a level heading or one of its files. */
export interface MemoryRow {
  id: string
  level: MemoryLevel
  file?: MemoryFile
}

export function memoryRows(levels: readonly MemoryLevel[]): MemoryRow[] {
  return levels.flatMap((level): MemoryRow[] => [
    { id: `level:${level.label}`, level },
    ...level.files.map((file) => ({ id: `file:${file.path}`, level, file })),
  ])
}

/** Markdown preview of a memory row: the file, or the level's file listing. */
export function memoryPreview(row: MemoryRow): string {
  if (row.file) return row.file.content
  if (row.level.files.length === 0) return `_no memory files in ${row.level.path}_`
  const names = row.level.files.map((f) => `- \`${f.path}\``).join("\n")
  return `**${row.level.label}** \`${row.level.path}\`\n\n${names}\n`
}
