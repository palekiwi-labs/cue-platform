import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { HasSession } from "../lib/session-thresholds"
import { buildReport, formatReport, type Thresholds } from "../lib/context-usage"

const parameters = Type.Object({})

interface ContextUsageLike {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export function cueContextUsageTool(
  thresholds: (ctx: HasSession) => Thresholds,
): ToolDefinition<typeof parameters> {
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

      const limits = thresholds(ctx)
      const report = buildReport(usage.tokens, limits)
      const text = formatReport(report, limits)
      return {
        content: [{ type: "text", text }],
        details: {
          tokens: report.tokens,
          context_window: usage.contextWindow,
          percent: usage.percent,
          caution_limit: limits.caution,
          soft_limit: limits.soft,
          hard_limit: limits.hard,
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
