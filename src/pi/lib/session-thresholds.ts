import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS, type Thresholds } from "./context-usage"

/** Why a set of thresholds was rejected, or null when it is valid. */
export function thresholdsError(t: Thresholds, contextWindow?: number): string | null {
  const values = [t.caution, t.soft, t.hard]
  if (!values.every((v) => Number.isInteger(v) && v > 0)) {
    return "thresholds must be positive whole token counts"
  }
  if (!(t.caution < t.soft)) return "caution must be below soft"
  if (!(t.soft < t.hard)) return "soft must be below hard"
  if (contextWindow !== undefined && t.hard > contextWindow) {
    return `hard must not exceed the context window (${contextWindow.toLocaleString("en-US")})`
  }
  return null
}

/** In-memory saturation thresholds for the current session. */
export class SessionThresholds {
  private current: Thresholds = { ...DEFAULT_THRESHOLDS }

  /** The effective thresholds. */
  get(): Thresholds {
    return { ...this.current }
  }

  /** Whether the effective thresholds differ from the defaults. */
  adjusted(): boolean {
    const t = this.current
    return t.caution !== DEFAULT_THRESHOLDS.caution ||
      t.soft !== DEFAULT_THRESHOLDS.soft ||
      t.hard !== DEFAULT_THRESHOLDS.hard
  }

  /** Replace the thresholds; returns the validation error and keeps the old values when invalid. */
  set(t: Thresholds, contextWindow?: number): string | null {
    const error = thresholdsError(t, contextWindow)
    if (error === null) this.current = { caution: t.caution, soft: t.soft, hard: t.hard }
    return error
  }

  /** Restore the defaults. */
  reset(): void {
    this.current = { ...DEFAULT_THRESHOLDS }
  }
}

/** A thresholds holder that resets to the defaults whenever a session starts. */
export function registerSessionThresholds(pi: ExtensionAPI): SessionThresholds {
  const holder = new SessionThresholds()
  pi.on("session_start", () => holder.reset())
  return holder
}
