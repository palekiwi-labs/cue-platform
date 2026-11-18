import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerNatsTelemetry } from "./extension"
import { registerAgentMonitorCommand } from "./monitor-command"
import { registerOperatorEvents } from "./operator-extension"

export default function natsTelemetry(pi: ExtensionAPI): void {
  registerNatsTelemetry(pi)
  registerOperatorEvents(pi)
  registerAgentMonitorCommand(pi)
}
