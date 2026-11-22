import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerNatsTelemetry } from "./extension"
import { registerAgentMonitorCommand } from "./monitor-command"
import { registerSessionSubscriptions } from "./subscriptions"

export default function natsTelemetry(pi: ExtensionAPI): void {
  registerNatsTelemetry(pi)
  registerSessionSubscriptions(pi)
  registerAgentMonitorCommand(pi)
}
