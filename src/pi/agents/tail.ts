/**
 * Byte-offset tailer for a run's events.jsonl: reads only appended
 * bytes, keeps the incomplete last line, and feeds complete lines to a
 * StreamState. One tailer per selected run, owned by the command wiring.
 */

import { open, stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { createStream, feedLine, type StreamItem, type StreamState } from "./stream"

/** Matches cue-agent's own cap on a single event line. */
const MAX_LINE = 1_000_000

export class EventTail {
  /** Bumped on every line consumed; cache key for rendered output. */
  version = 0
  private offset = 0
  private rest = ""
  private decoder = new StringDecoder("utf8")
  private inflight: Promise<boolean> | undefined

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

  /** Read new bytes; true when the timeline changed. Overlapping calls share one read. */
  poll(): Promise<boolean> {
    this.inflight ??= this.read().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async read(): Promise<boolean> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return false
    }
    if (size === this.offset) return false
    let changed = false
    if (size < this.offset) {
      this.offset = 0
      this.rest = ""
      this.decoder = new StringDecoder("utf8")
      Object.assign(this.state, createStream())
      this.version++
      changed = true
    }
    // The handle lives only inside poll: a cached one would be garbage
    // collected later and crash pi for closing it implicitly.
    const fh = await open(this.path, "r")
    let text: string
    try {
      const buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      this.offset += bytesRead
      text = this.rest + this.decoder.write(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
    const lines = text.split("\n")
    this.rest = lines.pop() ?? ""
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
}
