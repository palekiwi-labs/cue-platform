import { execFile } from "node:child_process";
import type { Checks, Pr, ReviewDecision } from "./protocol.js";

export type Graphql = (
  query: string,
  variables: Record<string, string | number>,
  signal?: AbortSignal,
) => Promise<unknown>;

export class RateLimitError extends Error {
  constructor(readonly until: number) {
    super("GitHub rate limited");
  }
}

export const LOW_REMAINING = 100;
const SECONDARY_PAUSE_MS = 60_000;
const PRIMARY_PAUSE_MS = 300_000;
const MAX_PAUSE_MS = 7_200_000;

export interface GhResponse {
  status: number | null;
  headers: Map<string, string>;
  body: string;
}

export function parseIncluded(stdout: string): GhResponse {
  const headers = new Map<string, string>();
  if (!stdout.startsWith("HTTP/"))
    return { status: null, headers, body: stdout };
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split ? stdout.slice(0, split.index) : stdout;
  const body = split ? stdout.slice(split.index + split[0].length) : "";
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1]);
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
  }
  return { status: Number.isInteger(status) ? status : null, headers, body };
}

function headerInteger(
  headers: Map<string, string>,
  name: string,
): number | null {
  const value = headers.get(name);
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function retryAfter(headers: Map<string, string>, now: number): number | null {
  const value = headers.get("retry-after");
  if (value === undefined) return null;
  if (/^\d+$/.test(value)) return now + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : date;
}

function bodyErrors(body: string): { types: string[]; messages: string[] } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    const types: string[] = [];
    const messages: string[] = [];
    for (const e of errors) {
      if (typeof e?.type === "string") types.push(e.type);
      if (typeof e?.message === "string") messages.push(e.message);
    }
    if (typeof parsed?.message === "string") messages.push(parsed.message);
    return { types, messages };
  } catch {
    return { types: [], messages: [] };
  }
}

export function rateLimitUntil(
  response: GhResponse,
  stderr: string,
  now: number,
): number | null {
  const { status, headers } = response;
  const errors = bodyErrors(response.body);
  const text = [stderr, ...errors.messages].join("\n");
  const remaining = headerInteger(headers, "x-ratelimit-remaining");
  const reset = headerInteger(headers, "x-ratelimit-reset");
  const retry = retryAfter(headers, now);
  const limited =
    status === 429 ||
    /\bHTTP 429\b/.test(stderr) ||
    errors.types.includes("RATE_LIMITED") ||
    /rate limit/i.test(text) ||
    (status === 403 && (remaining === 0 || retry !== null));
  if (!limited) return null;
  let until: number;
  if (retry !== null) until = retry;
  else if (remaining === 0 && reset !== null) until = reset * 1000 + 1000;
  else if (
    /secondary/i.test(text) ||
    status === 429 ||
    /\bHTTP 429\b/.test(stderr)
  )
    until = now + SECONDARY_PAUSE_MS;
  else until = now + PRIMARY_PAUSE_MS;
  return Math.min(Math.max(until, now + 1000), now + MAX_PAUSE_MS);
}

export function lowRemainingUntil(response: GhResponse): number | null {
  const remaining = headerInteger(response.headers, "x-ratelimit-remaining");
  const reset = headerInteger(response.headers, "x-ratelimit-reset");
  return remaining !== null && reset !== null && remaining < LOW_REMAINING
    ? reset * 1000 + 1000
    : null;
}

export function createGhGraphql(
  onLowRemaining: (until: number) => void = () => {},
  now: () => number = Date.now,
): Graphql {
  return (query, variables, signal) =>
    new Promise((resolve, reject) => {
      const args = [
        "api",
        "graphql",
        "--include",
        "--hostname",
        "github.com",
        "-f",
        `query=${query}`,
      ];
      for (const [key, value] of Object.entries(variables)) {
        if (key === "credentialOwner") continue;
        args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
      }
      const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
      if (
        String(variables.owner ?? "").toLowerCase() === "spabreaks" ||
        String(variables.credentialOwner ?? "").toLowerCase() === "spabreaks"
      ) {
        Object.assign(env, { GH_TOKEN: "PLACEHOLDER-gh-spabreaks" });
      }
      execFile(
        "gh",
        args,
        { env, signal, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const response = parseIncluded(String(stdout ?? ""));
          if (error) {
            const until =
              signal?.aborted || error.killed
                ? null
                : rateLimitUntil(response, String(stderr ?? ""), now());
            return reject(
              until === null
                ? new Error("GitHub subprocess failed")
                : new RateLimitError(until),
            );
          }
          const low = lowRemainingUntil(response);
          if (low !== null) onLowRemaining(low);
          try {
            resolve(JSON.parse(response.body));
          } catch {
            reject(new Error("Invalid GitHub JSON"));
          }
        },
      );
    });
}

export const ghGraphql: Graphql = createGhGraphql();

const connectionFields = "pageInfo { hasNextPage endCursor } totalCount";
export const PR_QUERY = `query($owner:String!,$name:String!,$cursor:String) {
  viewer { login }
  repository(owner:$owner,name:$name) {
    nameWithOwner defaultBranchRef { name }
    pullRequests(states:OPEN,first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}) {
      ${connectionFields}
      nodes {
        id number title url isDraft createdAt updatedAt reviewDecision baseRefName headRefName
        author { login }
        labels(first:100) { ${connectionFields} nodes { name } }
        reviewRequests(first:100) { ${connectionFields} nodes { requestedReviewer { ... on User { login } } } }
        commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, any>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected string");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Expected integer");
  return value as number;
}
export function data(value: unknown): Record<string, any> {
  const envelope = object(value);
  if (
    envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length)
  )
    throw new Error("GraphQL errors");
  return object(envelope.data);
}
function page(value: unknown): {
  nodes: Record<string, any>[];
  total: number;
  cursor: string | null;
} {
  const c = object(value);
  const info = object(c.pageInfo);
  if (!Array.isArray(c.nodes) || typeof info.hasNextPage !== "boolean")
    throw new Error("Invalid connection");
  return {
    nodes: c.nodes.map(object),
    total: integer(c.totalCount),
    cursor: info.hasNextPage ? text(info.endCursor) : null,
  };
}

async function nested(
  first: unknown,
  id: string,
  field: "labels" | "reviewRequests",
  owner: string,
  graphql: Graphql,
  signal?: AbortSignal,
): Promise<Record<string, any>[]> {
  let p = page(first);
  const total = p.total;
  const nodes = [...p.nodes];
  const seen = new Set<string>();
  while (p.cursor) {
    if (seen.has(p.cursor)) throw new Error("Repeated cursor");
    seen.add(p.cursor);
    const selection =
      field === "labels"
        ? "name"
        : "requestedReviewer { ... on User { login } }";
    const result = data(
      await graphql(
        `query($id:ID!,$cursor:String!) { node(id:$id) { ... on PullRequest { ${field}(first:100,after:$cursor) { ${connectionFields} nodes { ${selection} } } } } }`,
        { id, cursor: p.cursor, credentialOwner: owner },
        signal,
      ),
    );
    p = page(object(result.node)[field]);
    if (p.total !== total)
      throw new Error("Connection changed during collection");
    nodes.push(...p.nodes);
    if (nodes.length > total) throw new Error("Connection overflow");
  }
  if (nodes.length !== total) throw new Error("Incomplete connection");
  return nodes;
}

export async function collect(
  repo: string,
  graphql: Graphql = ghGraphql,
  signal?: AbortSignal,
): Promise<{ viewer: string; prs: Pr[] }> {
  const [owner, name] = repo.split("/");
  let cursor: string | null = null;
  let viewer = "";
  let total: number | undefined;
  const cursors = new Set<string>();
  const numbers = new Set<number>();
  const prs: Pr[] = [];
  do {
    const result = data(
      await graphql(
        PR_QUERY,
        { owner, name, ...(cursor ? { cursor } : {}) },
        signal,
      ),
    );
    const login = text(object(result.viewer).login);
    if (viewer && viewer !== login)
      throw new Error("Viewer changed during collection");
    viewer = login;
    const repository = object(result.repository);
    if (text(repository.nameWithOwner).toLowerCase() !== repo.toLowerCase())
      throw new Error("Unexpected repository");
    const defaultBranch =
      repository.defaultBranchRef === null
        ? ""
        : text(object(repository.defaultBranchRef).name);
    const p = page(repository.pullRequests);
    total ??= p.total;
    if (total !== p.total)
      throw new Error("PR count changed during collection");
    for (const n of p.nodes) {
      const number = integer(n.number);
      if (!number || numbers.has(number) || typeof n.isDraft !== "boolean")
        throw new Error("Invalid PR");
      numbers.add(number);
      const labels = await nested(
        n.labels,
        text(n.id),
        "labels",
        owner,
        graphql,
        signal,
      );
      const requests = await nested(
        n.reviewRequests,
        text(n.id),
        "reviewRequests",
        owner,
        graphql,
        signal,
      );
      const commits = object(n.commits).nodes;
      if (!Array.isArray(commits) || commits.length > 1)
        throw new Error("Invalid commits");
      const checks = commits.length
        ? object(object(commits[0]).commit).statusCheckRollup
        : null;
      const state = checks === null ? null : text(object(checks).state);
      if (
        state !== null &&
        !["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].includes(state)
      )
        throw new Error("Invalid checks");
      if (
        n.reviewDecision !== null &&
        !["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(
          n.reviewDecision,
        )
      )
        throw new Error("Invalid review decision");
      prs.push({
        repo,
        number,
        title: text(n.title),
        url: text(n.url),
        author: n.author === null ? "ghost" : text(object(n.author).login),
        isDraft: n.isDraft,
        createdAt: text(n.createdAt),
        updatedAt: text(n.updatedAt),
        reviewDecision: n.reviewDecision as ReviewDecision,
        checks: state as Checks,
        baseRef: text(n.baseRefName),
        headRef: text(n.headRefName),
        defaultBranch,
        labels: labels.map((l) => text(l.name)),
        reviewers: requests.flatMap((r) => {
          const reviewer = r.requestedReviewer;
          if (reviewer === null) return [];
          const login = object(reviewer).login;
          return login === undefined ? [] : [text(login)];
        }),
      });
    }
    cursor = p.cursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated cursor");
    if (cursor) cursors.add(cursor);
    if (prs.length > total) throw new Error("PR overflow");
  } while (cursor);
  if (prs.length !== total) throw new Error("Incomplete PR connection");
  return { viewer, prs };
}
