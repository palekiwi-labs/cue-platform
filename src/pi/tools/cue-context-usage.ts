import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { buildReport, formatReport, DEFAULT_THRESHOLDS } from "../lib/context-usage"

const parameters = Type.Object({})

interface ContextUsageLike {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export function cueContextUsageTool(): ToolDefinition<typeof parameters> {
  return {
    name: "cue-context-usage",
    label: "cue context usage",
    description:
      "Check this session's context token saturation against " +
      "caution/soft/hard limits. Call at milestones (after commits, " +
      "before starting the next plan item, after large reads) to decide " +
      "whether to continue or hand off.",
    parameters,
    async execute(_toolCallId, _args, _signal, _onUpdate, ctx) {
      // pi tracks the estimate natively (null right after compaction); the
      // thresholds and decision model mirror the opencode tool.
      const usage: ContextUsageLike | undefined =
        typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined

      if (!usage || usage.tokens == null) {
        return {
          content: [
            {
              type: "text",
              text:
                "Context usage unavailable: token count unknown (this can " +
                "happen right after compaction).",
            },
          ],
          details: { available: false },
        }
      }

      const report = buildReport(usage.tokens)
      const text = formatReport(report)
      return {
        content: [{ type: "text", text }],
        details: {
          tokens: report.tokens,
          context_window: usage.contextWindow,
          percent: usage.percent,
          caution_limit: DEFAULT_THRESHOLDS.caution,
          soft_limit: DEFAULT_THRESHOLDS.soft,
          hard_limit: DEFAULT_THRESHOLDS.hard,
          headroom_soft: report.headroom.soft,
          headroom_hard: report.headroom.hard,
          level: report.level,
          can_proceed_small_task: report.canProceed.smallTask,
          can_proceed_large_task: report.canProceed.largeTask,
        },
      }
    },
  }
}
