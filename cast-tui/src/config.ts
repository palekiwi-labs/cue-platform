import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findCheckout, isDirectory } from "./checkouts.js";
import type { Exec } from "./exec.js";
import type { HostAction, Outcome } from "./picker/prs/browser.js";
import type { Pr } from "./picker/prs/model.js";

export const CONFIG_FILE = "cast-tui.json";

/** A shell command bound to a key in the PR picker. */
export interface CommandAction {
  key: string;
  label: string;
  command: string;
  confirm: boolean;
}

export interface Config {
  prActions: CommandAction[];
}

/** A cast-tui.json that cast-tui cannot use. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAction(raw: unknown, index: number): CommandAction {
  const where = `prActions[${index}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} is not an object`);
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(`${where}.${key} is not a non-empty string`);
    }
    return value;
  };
  const confirm = raw.confirm ?? false;
  if (typeof confirm !== "boolean") {
    throw new ConfigError(`${where}.confirm is not a boolean`);
  }
  return {
    key: text("key"),
    label: text("label"),
    command: text("command"),
    confirm,
  };
}

/** Parses cast-tui.json, throwing ConfigError on anything malformed. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not JSON`);
  }
  if (!isObject(raw)) throw new ConfigError(`${CONFIG_FILE} is not an object`);
  const actions = raw.prActions ?? [];
  if (!Array.isArray(actions)) {
    throw new ConfigError("prActions is not a list");
  }
  return { prActions: actions.map(parseAction) };
}

/** Environment a command action runs with, describing its PR. */
export function prEnv(pr: Pr): Record<string, string> {
  return {
    PR_NUMBER: String(pr.number),
    PR_URL: pr.url,
    PR_BRANCH: pr.headRef,
    PR_REPO: pr.repo,
  };
}

/** The last non-empty output line, stdout and stderr combined. */
export function outputTail(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/** Runs an action's command in the checkout via `sh -c`. */
export async function runCommand(
  exec: Exec,
  action: CommandAction,
  checkout: string,
  pr: Pr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Outcome> {
  const r = await exec("sh", ["-c", action.command], {
    cwd: checkout,
    env: { ...env, ...prEnv(pr) },
  });
  const tail = outputTail(r.stdout, r.stderr);
  if (r.code === 0) {
    return { ok: true, text: `${action.label}: ${tail || "done"}` };
  }
  return {
    ok: false,
    text: `${action.label} failed (exit ${r.code})${tail ? `: ${tail}` : ""}`,
  };
}

export interface ConfigSources {
  exec: Exec;
  roots: string[];
  isDir?: (path: string) => boolean;
  /** File contents, or undefined when the file does not exist. */
  readFile?: (path: string) => string | undefined;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Host actions from the cast-tui.json of each PR's local checkout. A repo
 * without a checkout, without the file, or with a malformed file gets
 * none. Configs are read once per checkout.
 */
export function configActions(s: ConfigSources): (pr: Pr) => HostAction[] {
  const isDir = s.isDir ?? isDirectory;
  const readFile = s.readFile ?? readIfExists;
  const cache = new Map<string, CommandAction[]>();
  const configured = (checkout: string): CommandAction[] => {
    let actions = cache.get(checkout);
    if (actions === undefined) {
      const text = readFile(join(checkout, CONFIG_FILE));
      try {
        actions = text === undefined ? [] : parseConfig(text).prActions;
      } catch {
        actions = [];
      }
      cache.set(checkout, actions);
    }
    return actions;
  };
  return (pr) => {
    const checkout = findCheckout(pr.repo, s.roots, isDir);
    if (checkout === undefined) return [];
    return configured(checkout).map((action) => ({
      key: action.key,
      label: action.label,
      confirm: action.confirm,
      run: (target) => runCommand(s.exec, action, checkout, target),
    }));
  };
}
