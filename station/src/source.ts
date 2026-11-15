import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPacketFromDiff, diffRange } from "./gen.js";
import { run, runAsync, spawnAsync } from "./git.js";
import type { Packet } from "./packet.js";

export interface Review {
  key: string;
  title: string;
  subtitle: string;
  repoPath: string;
  packet: Packet;
}

function topLevel(cwd: string): string {
  return run(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function mainRepo(cwd: string): string {
  const common = run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return dirname(common);
}

export function repoSlug(repo: string): string {
  const url = run(repo, ["remote", "get-url", "origin"]).trim();
  const m = url.match(/github\.com[:/](.+?)(\.git)?$/);
  return m?.[1] ?? repo;
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

async function ghPr(repo: string, number: string): Promise<GhPr> {
  const out = await spawnAsync(
    "gh",
    ["pr", "view", number, "--json", "number,title,url,baseRefName,headRefName,headRefOid"],
    repo,
  );
  return JSON.parse(out) as GhPr;
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: string;
  requested: string[];
}

interface GhPrListItem {
  number: number;
  title: string;
  author: { login: string } | null;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  reviewRequests: { login?: string; name?: string; slug?: string }[];
}

export function prRepo(cwd: string): string | null {
  try {
    const repo = mainRepo(cwd);
    return /github\.com[:/]/.test(run(repo, ["remote", "get-url", "origin"])) ? repo : null;
  } catch {
    return null;
  }
}

export const PR_LIMIT = 200;

export async function listPrs(repo: string): Promise<PrSummary[]> {
  const out = await spawnAsync(
    "gh",
    [
      "pr",
      "list",
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number,title,author,headRefName,isDraft,updatedAt,reviewDecision,reviewRequests",
    ],
    repo,
  );
  return (JSON.parse(out) as GhPrListItem[]).map((p) => ({
    number: p.number,
    title: p.title,
    author: p.author?.login ?? "",
    headRefName: p.headRefName,
    isDraft: p.isDraft,
    updatedAt: p.updatedAt,
    reviewDecision: p.reviewDecision ?? "",
    requested: p.reviewRequests.map((r) => r.login ?? r.slug ?? r.name ?? "").filter((s) => s !== ""),
  }));
}

async function ensureWorktree(repo: string, path: string, sha: string): Promise<void> {
  if (existsSync(path)) {
    await runAsync(path, ["checkout", "-q", "--detach", sha]);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  await runAsync(repo, ["worktree", "add", "-q", "--detach", path, sha]);
}

function build(repoPath: string, baseSha: string, headSha: string, subject: string): Packet {
  const diff = diffRange(repoPath, baseSha, headSha);
  const branch = run(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return buildPacketFromDiff(diff, { repoPath, branch, baseSha, headSha, subject, now: Date.now() });
}

export async function fromPr(cwd: string, number: string): Promise<Review> {
  const repo = mainRepo(cwd);
  const pr = await ghPr(repo, number);
  const headRef = `refs/station/pr/${pr.number}/head`;
  const baseRef = `refs/station/pr/${pr.number}/base`;
  await runAsync(repo, [
    "fetch",
    "-q",
    "origin",
    `+refs/pull/${pr.number}/head:${headRef}`,
    `+refs/heads/${pr.baseRefName}:${baseRef}`,
  ]);
  const headSha = (await runAsync(repo, ["rev-parse", headRef])).trim();
  const baseSha = (await runAsync(repo, ["merge-base", baseRef, headSha])).trim();
  const wt = join(repo, "worktrees", "review", `pr-${pr.number}`);
  await ensureWorktree(repo, wt, headSha);
  const slug = repoSlug(repo);
  return {
    key: `${slug.replace(/\//g, "-")}-pr-${pr.number}`,
    title: `#${pr.number}  ${pr.title}`,
    subtitle: `${slug}  ${pr.headRefName} -> ${pr.baseRefName}`,
    repoPath: wt,
    packet: build(wt, baseSha, headSha, pr.title),
  };
}

function defaultBase(repo: string): string {
  try {
    return run(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).trim();
  } catch {
    return "origin/master";
  }
}

export function fromRange(cwd: string, range: string | undefined): Review {
  const repo = topLevel(cwd);
  let baseRef: string;
  let headRef: string;
  if (range === undefined) {
    headRef = "HEAD";
    baseRef = run(repo, ["merge-base", defaultBase(repo), "HEAD"]).trim();
  } else {
    const parts = range.split("..");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      throw new Error(`range must be <base>..<head>, got: ${range}`);
    }
    baseRef = parts[0] as string;
    headRef = parts[1] as string;
  }
  const baseSha = run(repo, ["rev-parse", `${baseRef}^{commit}`]).trim();
  const headSha = run(repo, ["rev-parse", `${headRef}^{commit}`]).trim();
  const branch = run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const subject = run(repo, ["log", "-1", "--format=%s", headSha]).trim();
  const slug = repoSlug(repo);
  return {
    key: `${slug.replace(/\//g, "-")}-${baseSha.slice(0, 7)}-${headSha.slice(0, 7)}`,
    title: subject,
    subtitle: `${slug}  ${branch}  ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`,
    repoPath: repo,
    packet: build(repo, baseSha, headSha, subject),
  };
}

export function fromDemo(): Review {
  const here = dirname(new URL(import.meta.url).pathname);
  const diff = readFileSync(join(here, "..", "demo", "demo.diff"), "utf8");
  const packet = buildPacketFromDiff(diff, {
    repoPath: "/home/pl/nix-config",
    branch: "feat/agent-microvm",
    baseSha: "30a461ee956419b78d326e6466da7f187e8b6a81",
    headSha: "9d8a3972018f35241e0b80180c46c110185d2fd7",
    subject: "nvim: cue C-t and A-a also in insert mode",
    now: Date.now(),
  });
  return {
    key: "demo",
    title: "demo  nvim: cue C-t and A-a also in insert mode",
    subtitle: "palekiwi/nix-config  feat/agent-microvm  30a461e..9d8a397",
    repoPath: packet.repo_path,
    packet,
  };
}
