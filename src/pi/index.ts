import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerAcuityListener } from "./acuity"
import { registerContextCurrentCommand } from "./commands/context-current"
import { registerCueBrowser } from "./commands/cue-browser"
import { registerContextInjectCommand } from "./commands/context-inject"
import { registerContextPinsCommand } from "./commands/context-pins"
import { registerIdeaCommand } from "./commands/idea"
import { registerReviewRunCommand } from "./commands/review-run"
import { registerMcpCastAdapter } from "./mcp"
import { registerSessionNaming } from "./session-name"
import { registerCueSkillInjection } from "./skill-injection"
import { cueAddTool } from "./tools/cue-add"
import { cueContextTool } from "./tools/cue-context"
import { cueContextUsageTool } from "./tools/cue-context-usage"
import { cueLogTool } from "./tools/cue-log"
import { cuePlanTool } from "./tools/cue-plan"
import { cueReviewTool } from "./tools/cue-review"
import { cueTaskTool } from "./tools/cue-task"
import { saveBranchDiffTool } from "./tools/save-branch-diff"
import { delegateTool } from "./tools/delegate"

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
  pi.registerTool(cueContextUsageTool())
  pi.registerTool(cueLogTool(pi))
  pi.registerTool(cuePlanTool(pi))
  pi.registerTool(cueReviewTool(pi))
  pi.registerTool(cueTaskTool(pi))
  pi.registerTool(saveBranchDiffTool(pi))
  pi.registerTool(delegateTool())

  registerContextCurrentCommand(pi)
  registerContextInjectCommand(pi)
  registerContextPinsCommand(pi)
  registerCueBrowser(pi)
  registerIdeaCommand(pi)
  registerReviewRunCommand(pi)
  registerAcuityListener(pi)
  registerMcpCastAdapter(pi)
  registerCueSkillInjection(pi)
  registerSessionNaming(pi)
}
