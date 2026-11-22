import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS, type Thresholds } from "./context-usage"
import { thresholdsError } from "./session-thresholds"

/** Settings read from `cue-platform.json`, with built-in values filled in. */
export interface CuePlatformConfig {
  context: {
    thresholds: Thresholds
    /** Whether `context.thresholds` came from the file rather than the built-ins. */
    configured: boolean
    /** Complete thresholds per session mode, missing fields filled from the global ones. */
    modes: Record<string, Thresholds>
  }
}

/** A loaded config and the problems found while reading it. */
export interface LoadedConfig {
  config: CuePlatformConfig
  warnings: string[]
}

/** Location of the config file: `$XDG_CONFIG_HOME/cue-platform/cue-platform.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "cue-platform", "cue-platform.json")
}

function builtIn(): CuePlatformConfig {
  return { context: { thresholds: { ...DEFAULT_THRESHOLDS }, configured: false, modes: {} } }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Parse config text; values that are missing or invalid fall back to the built-in ones. */
export function parseConfig(text: string): LoadedConfig {
  const config = builtIn()
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { config, warnings: [`invalid JSON: ${(e as Error).message}`] }
  }
  if (!isObject(raw)) return { config, warnings: ["top level must be an object"] }
  const context = raw.context
  if (context === undefined) return { config, warnings }
  if (!isObject(context)) return { config, warnings: ["context must be an object"] }
  const t = context.thresholds
  if (t !== undefined) {
    if (!isObject(t)) warnings.push("context.thresholds must be an object")
    else {
      const merged = mergeThresholds(config.context.thresholds, t, "context.thresholds", warnings)
      const error = thresholdsError(merged)
      if (error !== null) warnings.push(`context.thresholds: ${error}; using the built-in defaults`)
      else {
        config.context.thresholds = merged
        config.context.configured = true
      }
    }
  }
  const modes = context.modes
  if (modes === undefined) return { config, warnings }
  if (!isObject(modes)) return { config, warnings: [...warnings, "context.modes must be an object"] }
  for (const [mode, entry] of Object.entries(modes)) {
    const where = `context.modes.${mode}.thresholds`
    const mt = isObject(entry) ? entry.thresholds : undefined
    if (!isObject(mt)) {
      warnings.push(`${where} must be an object`)
      continue
    }
    const merged = mergeThresholds(config.context.thresholds, mt, where, warnings)
    const error = thresholdsError(merged)
    if (error !== null) warnings.push(`${where}: ${error}; using the global defaults`)
    else config.context.modes[mode] = merged
  }
  return { config, warnings }
}

function mergeThresholds(
  base: Thresholds,
  t: Record<string, unknown>,
  where: string,
  warnings: string[],
): Thresholds {
  const merged = { ...base }
  for (const key of ["caution", "soft", "hard"] as const) {
    const v = t[key]
    if (v === undefined) continue
    if (typeof v === "number" && Number.isInteger(v) && v > 0) merged[key] = v
    else warnings.push(`${where}.${key} must be a positive whole token count`)
  }
  return merged
}

/** Read the config file; a missing file yields the built-in config without warnings. */
export function loadConfig(path: string = configPath()): LoadedConfig {
  if (!existsSync(path)) return { config: builtIn(), warnings: [] }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { config: builtIn(), warnings: [`cannot read: ${(e as Error).message}`] }
  }
  return parseConfig(text)
}

let current: CuePlatformConfig = builtIn()

/** The config loaded at the last session start. */
export function config(): CuePlatformConfig {
  return current
}

/** Where a set of default thresholds comes from. */
export type DefaultsSource = { kind: "mode"; mode: string } | { kind: "config" } | { kind: "built-in" }

/** The default thresholds for a session in `mode`, and where they come from. */
export function resolveDefaults(mode?: string): { thresholds: Thresholds; source: DefaultsSource } {
  const c = current.context
  const byMode = mode === undefined ? undefined : Object.hasOwn(c.modes, mode) ? c.modes[mode] : undefined
  if (byMode) return { thresholds: { ...byMode }, source: { kind: "mode", mode: mode! } }
  return { thresholds: { ...c.thresholds }, source: { kind: c.configured ? "config" : "built-in" } }
}

/** The default thresholds new sessions start from, for an optional session mode. */
export function defaultThresholds(mode?: string): Thresholds {
  return resolveDefaults(mode).thresholds
}

/** Reload the config on every session start (incl. /reload) and report problems. */
export function registerConfig(pi: ExtensionAPI, path: () => string = configPath): void {
  const reload = () => {
    const loaded = loadConfig(path())
    current = loaded.config
    return loaded.warnings
  }
  reload()
  pi.on("session_start", (_event, ctx) => {
    const warnings = reload()
    if (warnings.length === 0 || !ctx.hasUI) return
    ctx.ui.notify(`${path()}: ${warnings.join("; ")}`, "warning")
  })
}
