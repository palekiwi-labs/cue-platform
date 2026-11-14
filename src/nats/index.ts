import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerNatsTelemetry } from "./extension"
import { registerAgentMonitorCommand } from "./monitor-command"

export default function natsTelemetry(pi: ExtensionAPI): void {
  registerNatsTelemetry(pi)
  registerAgentMonitorCommand(pi)
}
