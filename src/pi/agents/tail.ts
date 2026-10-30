/**
 * Byte-offset tailer for a run's events.jsonl: reads only appended
 * bytes, keeps the incomplete last line, and feeds complete lines to a
 * StreamState. One tailer per selected run, owned by the command wiring.
 */

import { open, stat } from "node:fs/promises"
import { createStream, feedLine, type StreamItem, type StreamState } from "./stream"

/** Matches cue-agent's own cap on a single event line. */
const MAX_LINE = 1_000_000

export class EventTail {
  /** Bumped on every line consumed; cache key for rendered output. */
  version = 0
  private offset = 0
  private rest = ""
  private fh: Awaited<ReturnType<typeof open>> | null = null

  constructor(
    readonly path: string,
    private readonly state: StreamState = createStream(),
  ) {}

  get skipped(): number {
    return this.state.skipped
  }

  items(): StreamItem[] {
    return this.state.items
  }

  /** Read new bytes; true when the timeline changed. */
  async poll(): Promise<boolean> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return false
    }
    if (size === this.offset) return false
    if (size < this.offset) {
      this.offset = 0
      this.rest = ""
    }
    this.fh ??= await open(this.path, "r")
    const buf = Buffer.alloc(size - this.offset)
    await this.fh.read(buf, 0, buf.length, this.offset)
    this.offset = size
    const lines = (this.rest + buf.toString("utf8")).split("\n")
    this.rest = lines.pop() ?? ""
    let changed = false
    for (const line of lines) {
      if (!line.trim()) continue
      feedLine(this.state, line)
      this.version++
      changed = true
    }
    if (this.rest.length > MAX_LINE) {
      this.state.skipped++
      this.rest = ""
    }
    return changed
  }

  close(): void {
    void this.fh?.close()
    this.fh = null
  }
}
