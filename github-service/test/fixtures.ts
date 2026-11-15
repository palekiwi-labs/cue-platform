import type { Pr } from "../src/protocol.js";

export const repo = "example/project";
export const pr: Pr = {
  repo,
  number: 1,
  title: "A change",
  url: "https://github.com/example/project/pull/1",
  author: "alice",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  reviewDecision: null,
  checks: "SUCCESS",
  baseRef: "main",
  headRef: "feature",
  defaultBranch: "main",
  reviewers: ["bob"],
  labels: ["bug"],
};
export function connection(
  nodes: unknown[],
  totalCount = nodes.length,
  endCursor: string | null = null,
) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
  };
}
export function node(number = 1) {
  return {
    id: `PR_${number}`,
    number,
    title: pr.title,
    url: pr.url,
    author: { login: pr.author },
    isDraft: false,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    reviewDecision: null,
    baseRefName: "main",
    headRefName: "feature",
    labels: connection([{ name: "bug" }]),
    reviewRequests: connection([{ requestedReviewer: { login: "bob" } }]),
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
  };
}
export function response(
  nodes: unknown[],
  total = nodes.length,
  cursor: string | null = null,
) {
  return {
    data: {
      viewer: { login: "viewer" },
      repository: {
        nameWithOwner: repo,
        defaultBranchRef: { name: "main" },
        pullRequests: connection(nodes, total, cursor),
      },
    },
  };
}
