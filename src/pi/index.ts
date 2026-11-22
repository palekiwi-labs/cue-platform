import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerAcuityListener } from "./acuity"
import { registerActivityRecording } from "./lib/activity"
import { registerCompactionTrigger } from "./compaction/trigger"
import { registerContextCurrentCommand } from "./commands/context-current"
import { registerCueBrowser } from "./commands/cue-browser"
import { registerContextInjectCommand } from "./commands/context-inject"
import { registerContextPinsCommand } from "./commands/context-pins"
import { registerIdeaCommand } from "./commands/idea"
import { registerMemoryMonitor } from "./commands/memory-monitor"
import { registerPrBrowser } from "./commands/prs"
import { registerReviewMissCommand } from "./commands/review-miss"
import { registerReviewRunCommand } from "./commands/review-run"
import { registerViewsLauncher } from "./commands/views-launcher"
import { registerSessionMenus } from "./commands/session-menus"
import { registerTurnSummary } from "./commands/turn-summary"
import { registerTurnReader } from "./commands/turn-reader"
import { registerMcpCastAdapter } from "./mcp"
import { registerSessionNaming } from "./session-name"
import { registerWelcomeHeader } from "./header"
import { registerSessionLabel } from "./session-label"
import { registerSessionEnv } from "./session-env"
import { registerStoreCommit } from "./store-commit"
import { registerCueSkillInjection } from "./skill-injection"
import { registerResponseStyle } from "./response-style"
import { registerSpeech } from "./speech"
import { cueAddTool } from "./tools/cue-add"
import { cueContextTool } from "./tools/cue-context"
import { cueContextExploreTool } from "./tools/cue-context-explore"
import { cueContextUsageTool } from "./tools/cue-context-usage"
import { cueLogTool } from "./tools/cue-log"
import { cuePlanTool } from "./tools/cue-plan"
import { cueRecallTool } from "./tools/cue-recall"
import { cueReviewTool } from "./tools/cue-review"
import { cueSessionLinkTool } from "./tools/cue-session-link"
import { cueTaskTool } from "./tools/cue-task"
import { saveBranchDiffTool } from "./tools/save-branch-diff"
import { delegateTool, supervisorStatusTool } from "./tools/delegate"

/**
 * Cue integration for the pi harness.
 *
 * Registers the cue tools (thin bridges over the CLI), orientation commands, and
 * exposes the cast MCP server's tools as generated `mcp-cast_*` tools.
 * Injects the full cue skill into every session's system prompt.
 * Installed via the repo-root `package.json` `pi` manifest.
 */
export default function cuePlatform(pi: ExtensionAPI): void {
  // Registered individually: each factory yields a distinctly-typed
  // ToolDefinition, so a homogeneous loop would widen to an incompatible union.
  pi.registerTool(cueAddTool(pi))
  pi.registerTool(cueContextTool(pi))
  pi.registerTool(cueContextExploreTool(pi))
  pi.registerTool(cueContextUsageTool())
  pi.registerTool(cueLogTool(pi))
  pi.registerTool(cuePlanTool(pi))
  pi.registerTool(cueRecallTool(pi))
  pi.registerTool(cueReviewTool(pi))
  pi.registerTool(cueSessionLinkTool(pi))
  pi.registerTool(cueTaskTool(pi))
  pi.registerTool(saveBranchDiffTool(pi))
  pi.registerTool(delegateTool())
  const statusTool = supervisorStatusTool()
  if (statusTool) pi.registerTool(statusTool)

  registerContextCurrentCommand(pi)
  registerContextInjectCommand(pi)
  registerContextPinsCommand(pi)
  registerCueBrowser(pi)
  registerMemoryMonitor(pi)
  registerPrBrowser(pi)
  registerViewsLauncher(pi)
  const speech = registerSpeech(pi)
  registerSessionMenus(pi, speech?.setting, speech?.voiceSetting)
  registerTurnSummary(pi, speech)
  registerTurnReader(pi, speech)
  registerIdeaCommand(pi)
  registerReviewRunCommand(pi)
  registerReviewMissCommand(pi)
  registerAcuityListener(pi)
  registerActivityRecording(pi)
  registerCompactionTrigger(pi)
  registerStoreCommit(pi)
  registerWelcomeHeader(pi)
  registerMcpCastAdapter(pi)
  registerCueSkillInjection(pi)
  registerResponseStyle(pi)
  registerSessionNaming(pi)
  registerSessionLabel(pi)
  registerSessionEnv(pi)
}
