// Pure logic for the pi cue-context-usage tool. Mirrors the opencode
// decision model (same thresholds, levels, guidance); the token count
// itself comes from pi's native ctx.getContextUsage() rather than an
// estimate over session messages.

export type SaturationLevel = "nominal" | "caution" | "exceeded_soft" | "critical"

export type Thresholds = {
  /** Below this: proceed with any task size. */
  caution: number
  /** At/above this: hand-off becomes mandatory. */
  soft: number
  /** At/above this: immediate halt. */
  hard: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  caution: 80_000,
  soft: 100_000,
  hard: 140_000,
}

export function resolveThresholds(options?: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...options }
}

export type UsageReport = {
  /** Total active context tokens. */
  tokens: number
  level: SaturationLevel
  headroom: {
    caution: number
    soft: number
    hard: number
  }
  canProceed: {
    smallTask: boolean
    largeTask: boolean
  }
  guidance: string
}

const GUIDANCE: Record<SaturationLevel, string> = {
  nominal:
    "Context headroom is healthy. Proceed freely, including broad " +
    "exploration and complex multi-file work.",
  caution:
    "Headroom below the soft cap. Proceed only with atomic steps " +
    "(under ~10k expected tokens); hand off before large discovery or " +
    "multi-file refactors.",
  exceeded_soft:
    "Soft cap exceeded. Hand-off mandatory: finish only the in-flight " +
    "atomic commit/log, start no new plan items, load the cue-handoff " +
    "skill.",
  critical:
    "Hard cap exceeded. Immediate halt: cease all edits, perform an " +
    "emergency hand-off log, and stop.",
}

// One-line context state note appended to tool outputs (e.g. cue-log).
// Deliberately number-free: the level name is the signal, not the count.
const CONTEXT_NOTE: Record<SaturationLevel, string> = {
  nominal: "Context: nominal.",
  caution: "Context: nearing saturation.",
  exceeded_soft:
    "Context: above the soft saturation limit — load the cue-handoff skill.",
  critical:
    "Context: above the hard saturation limit — load the cue-handoff skill immediately.",
}

export function contextNote(level: SaturationLevel): string {
  return CONTEXT_NOTE[level]
}

export function buildReport(
  tokens: number,
  thresholds?: Partial<Thresholds>,
): UsageReport {
  const t = resolveThresholds(thresholds)
  const level: SaturationLevel =
    tokens >= t.hard
      ? "critical"
      : tokens >= t.soft
        ? "exceeded_soft"
        : tokens >= t.caution
          ? "caution"
          : "nominal"
  const canProceed = {
    smallTask: level === "nominal" || level === "caution",
    largeTask: level === "nominal",
  }
  return {
    tokens,
    level,
    headroom: {
      caution: Math.max(0, t.caution - tokens),
      soft: Math.max(0, t.soft - tokens),
      hard: Math.max(0, t.hard - tokens),
    },
    canProceed,
    guidance: GUIDANCE[level],
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

export function formatReport(report: UsageReport, thresholds?: Partial<Thresholds>): string {
  const t = resolveThresholds(thresholds)
  return [
    "Context Saturation Checkpoint",
    `  Tokens: ${fmt(report.tokens)}`,
    `  Limits: caution ${fmt(t.caution)} / soft ${fmt(t.soft)} / hard ${fmt(t.hard)}`,
    `  Headroom: ${fmt(report.headroom.soft)} to soft / ${fmt(report.headroom.hard)} to hard`,
    `  Level: ${report.level.toUpperCase()}`,
    `  Guidance: ${report.guidance}`,
  ].join("\n")
}
