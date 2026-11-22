import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "cue-platform-test-config-"))
