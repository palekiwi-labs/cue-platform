import { execFile } from "node:child_process";
import type { Checks, Pr, ReviewDecision } from "./protocol.js";

export type Graphql = (
  query: string,
  variables: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;

export const ghGraphql: Graphql = (query, variables, signal) =>
  new Promise((resolve, reject) => {
    const args = [
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      `query=${query}`,
    ];
    for (const [key, value] of Object.entries(variables)) {
      if (key !== "credentialOwner") args.push("-f", `${key}=${value}`);
    }
    const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
    if (
      variables.owner?.toLowerCase() === "spabreaks" ||
      variables.credentialOwner?.toLowerCase() === "spabreaks"
    ) {
      Object.assign(env, { GH_TOKEN: "PLACEHOLDER-gh-spabreaks" });
    }
    execFile(
      "gh",
      args,
      { env, signal, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error("GitHub subprocess failed"));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid GitHub JSON"));
        }
      },
    );
  });

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

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, any>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected string");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Expected integer");
  return value as number;
}
function data(value: unknown): Record<string, any> {
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
