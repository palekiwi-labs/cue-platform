import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const STATE_FILE = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "cue-platform",
  "turn-summary.json",
)

interface TurnSummaryState {
  auto?: boolean
}

function readState(file: string): TurnSummaryState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TurnSummaryState
  } catch {
    return {}
  }
}

/** Whether every finished turn is summarized right away; off by default. */
export function autoSummary(file = STATE_FILE): boolean {
  return readState(file).auto === true
}

export function setAutoSummary(on: boolean, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...readState(file), auto: on }) + "\n")
}
