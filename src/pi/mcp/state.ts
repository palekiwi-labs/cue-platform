/** Connection state of the cast MCP server as seen by the adapter. */
export type ConnectionState =
  | { kind: "inactive" }
  | { kind: "connecting" }
  | { kind: "connected"; url?: string; toolCount: number }
  | { kind: "unreachable"; url?: string; error: string }

export const DEFAULT_BACKOFF_INITIAL_MS = 5_000
export const DEFAULT_BACKOFF_MAX_MS = 60_000

/** Exponential retry delay: doubles on each failure, capped, reset on success. */
export class Backoff {
  private failures = 0
  private nextAttemptAt = 0

  constructor(
    private readonly initialMs: number = DEFAULT_BACKOFF_INITIAL_MS,
    private readonly maxMs: number = DEFAULT_BACKOFF_MAX_MS,
    private readonly now: () => number = Date.now,
  ) {}

  ready(): boolean {
    return this.now() >= this.nextAttemptAt
  }

  failure(): void {
    const delay = Math.min(this.initialMs * 2 ** this.failures, this.maxMs)
    this.failures++
    this.nextAttemptAt = this.now() + delay
  }

  reset(): void {
    this.failures = 0
    this.nextAttemptAt = 0
  }
}
