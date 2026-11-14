import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerNatsTelemetry } from "./extension"

export default function natsTelemetry(pi: ExtensionAPI): void {
  registerNatsTelemetry(pi)
}
