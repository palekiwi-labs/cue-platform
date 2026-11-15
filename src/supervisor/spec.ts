import { isAbsolute } from "node:path";

export interface RunSpec {
  cwd: string;
  context: string;
  prompt: string;
  model?: string;
  timeoutSec?: number;
  worktree?: { base: string };
  agent?: AgentSpec;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Resolved pi-level agent definition; the supervisor never reads an agent roster. */
export interface AgentSpec {
  name: string;
  systemPrompt?: string;
  tools?: string[];
  thinking?: (typeof THINKING_LEVELS)[number];
  extensions?: string[];
  isolated?: boolean;
}

export interface BatchSpec {
  runs: RunSpec[];
}

export class SpecError extends Error {}

function fail(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

function parseRun(value: unknown, path: string): RunSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const run = value as Record<string, unknown>;
  const known = new Set(["cwd", "context", "prompt", "model", "timeoutSec", "worktree", "agent"]);
  for (const key of Object.keys(run)) if (!known.has(key)) fail(path, `unknown field ${key}`);
  if (typeof run.cwd !== "string" || !isAbsolute(run.cwd)) fail(`${path}.cwd`, "must be an absolute path");
  if (typeof run.context !== "string" || run.context === "") fail(`${path}.context`, "must be a non-empty string");
  if (typeof run.prompt !== "string" || run.prompt === "") fail(`${path}.prompt`, "must be a non-empty string");
  if (run.model !== undefined && (typeof run.model !== "string" || run.model === "")) {
    fail(`${path}.model`, "must be a non-empty string");
  }
  if (
    run.timeoutSec !== undefined &&
    (typeof run.timeoutSec !== "number" || !Number.isInteger(run.timeoutSec) || run.timeoutSec <= 0)
  ) {
    fail(`${path}.timeoutSec`, "must be a positive integer");
  }
  let worktree: RunSpec["worktree"];
  if (run.worktree !== undefined && run.worktree !== false) {
    if (run.worktree === true) worktree = { base: "HEAD" };
    else {
      const value = run.worktree as Record<string, unknown>;
      if (typeof value !== "object" || value === null || Array.isArray(value) ||
          typeof value.base !== "string" || value.base === "" || Object.keys(value).some((key) => key !== "base")) {
        fail(`${path}.worktree`, "must be a boolean or { base: non-empty string }");
      }
      worktree = { base: value.base as string };
    }
  }
  const agent = run.agent === undefined ? undefined : parseAgent(run.agent, `${path}.agent`);
  return {
    cwd: run.cwd,
    context: run.context,
    prompt: run.prompt,
    ...(worktree !== undefined ? { worktree } : {}),
    ...(run.model !== undefined ? { model: run.model as string } : {}),
    ...(run.timeoutSec !== undefined ? { timeoutSec: run.timeoutSec as number } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/** Validates a whole batch spec; throws SpecError on the first problem. */
export function parseBatchSpec(value: unknown): BatchSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("spec", "must be an object");
  const runs = (value as Record<string, unknown>).runs;
  if (!Array.isArray(runs) || runs.length === 0) fail("spec.runs", "must be a non-empty array");
  return { runs: runs.map((run, index) => parseRun(run, `spec.runs[${index}]`)) };
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    fail(path, "must be an array of non-empty strings");
  }
  return value as string[];
}

function parseAgent(value: unknown, path: string): AgentSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const agent = value as Record<string, unknown>;
  const known = new Set(["name", "systemPrompt", "tools", "thinking", "extensions", "isolated"]);
  for (const key of Object.keys(agent)) if (!known.has(key)) fail(path, `unknown field ${key}`);
  if (typeof agent.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(agent.name)) {
    fail(`${path}.name`, "must be 1-64 ASCII letters, digits, underscores or hyphens");
  }
  if (agent.systemPrompt !== undefined && (typeof agent.systemPrompt !== "string" || agent.systemPrompt === "")) {
    fail(`${path}.systemPrompt`, "must be a non-empty string");
  }
  if (agent.thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(agent.thinking)) {
    fail(`${path}.thinking`, `must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (agent.isolated !== undefined && typeof agent.isolated !== "boolean") fail(`${path}.isolated`, "must be a boolean");
  const tools = agent.tools === undefined ? undefined : stringList(agent.tools, `${path}.tools`);
  const extensions = agent.extensions === undefined ? undefined : stringList(agent.extensions, `${path}.extensions`);
  return {
    name: agent.name,
    ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt as string } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(agent.thinking !== undefined ? { thinking: agent.thinking as AgentSpec["thinking"] } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(agent.isolated === true ? { isolated: true } : {}),
  };
}
