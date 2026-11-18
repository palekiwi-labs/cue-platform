import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import type { ResolvedPr } from "./source.js";

export const PREPARER_MODEL = "9r/cc/claude-opus-5-5";
export const PREPARER_TOOLS = ["read", "bash", "grep", "find", "ls"];

export function preparerExtensions(_model: string): string[] {
  return [];
}

export const PREPARER_SYSTEM_PROMPT = `You are the walkthrough preparer for station, a terminal review tool.
You write a guided walkthrough of one pull request for a human reviewer who
has not seen the change yet. The reviewer reads it in a split view: an
outline of chunks and sections on the side, and the steps of the selected
section in the main pane, each step showing markdown prose above an
optional code snippet.

Your working directory is a checkout of the pull request head. Read the
diff with git (\`git diff <base> <head>\`, \`git log <base>..<head>\`) and
read the surrounding code at both revisions (\`git show <rev>:<path>\`)
until you understand what changed and why.

## What a good walkthrough does

- Orders the change for understanding, not by file: the core idea first,
  then what it touches, then wiring, then tests.
- Groups related edits into chunks (a theme) and sections (one idea each).
  A section has one or more steps; use several steps to compare before and
  after, or to follow a call from caller to callee.
- Explains intent, behaviour changes, edge cases and risks in plain prose.
  Says what the reviewer should check. Does not restate the code line by
  line and does not praise it.
- Shows the smallest snippet that carries the point, usually 3 to 30
  lines, taken from the real file at the stated revision.
- Covers every meaningful change in the diff; trivial edits (renames,
  formatting) can be summarised in one section without snippets.

## Format (version 2)

A single JSON object:

{
  "version": 2,
  "pr": <number>,
  "base": "<merge-base sha>",
  "head": "<head sha>",
  "title": "<one line>",
  "summary": "<markdown overview, with a suggested reading order>",
  "chunks": [
    {
      "id": "<kebab-case id>",
      "title": "<chunk title>",
      "summary": "<optional markdown>",
      "sections": [
        {
          "title": "<section title>",
          "steps": [
            {
              "markdown": "<prose shown above the snippet>",
              "code": { "path": "<repo-relative path>", "lines": [<start>, <end>], "rev": "base" }
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Every step has markdown, code, or both. No other fields are allowed
  anywhere.
- code.rev: omit it for the head revision, "base" for the merge-base, or a
  full 40-character sha of another commit in the PR. Never write "head".
- code.lines are 1-based, inclusive, and must exist in the file at that
  revision. Take them from \`git show <rev>:<path> | cat -n\`, never from
  diff hunk headers or memory.
- Use "base" snippets for code as it was before the change, including
  deleted files.

## Saving

Write the JSON to a temporary file outside the repository, then run the
save command given in the task. It validates the whole walkthrough against
the repository and reports every problem with its JSON path. Fix all of
them and run it again until it prints "saved <address>". Never write into
the cue store or the repository yourself. When it succeeds, reply with the
saved address and nothing else.`;

function quote(arg: string): string {
  return /^[A-Za-z0-9_\/.:=@+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The exact command the preparer runs to validate and save, using this station build. */
export function saveCommand(station: string[], pr: ResolvedPr): string {
  return [
    ...station,
    "walkthrough-save",
    "--repo",
    pr.repo,
    "--pr",
    String(pr.number),
    "--base",
    pr.baseSha,
    "--head",
    pr.headSha,
    "/tmp/walkthrough-pr-" + pr.number + ".json",
  ]
    .map(quote)
    .join(" ");
}

export function preparerPrompt(station: string[], pr: ResolvedPr): string {
  return [
    `Write a walkthrough for pull request #${pr.number} of ${pr.slug}: ${pr.title}`,
    `Branch ${pr.headRefName} into ${pr.baseRefName}.`,
    `Merge-base (base): ${pr.baseSha}`,
    `Head: ${pr.headSha}`,
    "",
    "Save it with this command (change the file path if you write elsewhere):",
    "",
    `    ${saveCommand(station, pr)}`,
  ].join("\n");
}

export interface PreparerRun {
  cwd: string;
  context: string;
  prompt: string;
  model: string;
  timeoutSec: number;
  worktree: { base: string };
  agent: {
    name: string;
    systemPrompt: string;
    tools: string[];
    thinking: "medium";
    isolated: boolean;
    extensions?: string[];
  };
}

export function preparerRun(station: string[], pr: ResolvedPr, model = PREPARER_MODEL): PreparerRun {
  return {
    cwd: pr.repo,
    context: `review-pr-${pr.number}`,
    prompt: preparerPrompt(station, pr),
    model,
    timeoutSec: 3600,
    worktree: { base: pr.headSha },
    agent: {
      name: "walkthrough-preparer",
      systemPrompt: PREPARER_SYSTEM_PROMPT,
      tools: PREPARER_TOOLS,
      thinking: "medium",
      isolated: true,
      ...(preparerExtensions(model).length > 0 ? { extensions: preparerExtensions(model) } : {}),
    },
  };
}

/** Submits runs to the NATS supervisor and returns the batch and run ids. */
export async function submitToSupervisor(runs: PreparerRun[]): Promise<{ batchId: string; runIds: string[] }> {
  const nc = await connect({
    servers: process.env.CUE_NATS_URL?.trim() || "nats://127.0.0.1:4222",
    name: "station",
    timeout: 2_000,
    reconnect: false,
  });
  try {
    const body = { requestId: `station-${randomUUID()}`, spec: { runs } };
    let msg;
    try {
      msg = await nc.request("agent.supervisor.v1.submit", JSON.stringify(body), { timeout: 10_000 });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      throw new Error(/no responders/i.test(text) ? "no supervisor is running" : `supervisor submit failed: ${text}`);
    }
    const reply = msg.json() as { ok: boolean; data?: { batchId: string; runIds: string[] }; error?: { message: string } };
    if (!reply.ok || reply.data === undefined) throw new Error(`supervisor rejected the run: ${reply.error?.message ?? "unknown error"}`);
    return reply.data;
  } finally {
    await nc.close();
  }
}
