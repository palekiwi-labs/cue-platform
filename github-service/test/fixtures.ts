import type { FeedbackThreadComment, Pr, PrFeedback } from "../src/protocol.js";

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

function feedbackPage(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}
export function feedbackComment(
  id: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    fullDatabaseId: id === "C1" ? 101 : null,
    author: { login: "bob", __typename: "User" },
    authorAssociation: "MEMBER",
    body: `body ${id}`,
    state: "SUBMITTED",
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: null,
    lastEditedAt: null,
    url: `https://github.com/example/project/pull/7#${id}`,
    isMinimized: false,
    minimizedReason: null,
    replyTo: null,
    pullRequestReview: { id: "R4", state: "COMMENTED" },
    path: "src/a.ts",
    commit: { oid: "head" },
    originalCommit: { oid: "head" },
    line: 1,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    outdated: false,
    diffHunk: "@@ -1 +1 @@",
    ...extra,
  };
}
export function feedbackThread(
  id: string,
  comments: ReturnType<typeof feedbackPage>,
  totalCount: number,
) {
  return {
    id,
    path: "src/a.ts",
    subjectType: "LINE",
    diffSide: "RIGHT",
    startDiffSide: null,
    line: 1,
    startLine: null,
    originalLine: 1,
    originalStartLine: null,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    resolvedBy: null,
    comments: { totalCount, ...comments },
  };
}
function entry(id: string, createdAt: string, extra = {}) {
  return {
    id,
    fullDatabaseId: null,
    author: { login: "carol", __typename: "User" },
    authorAssociation: "CONTRIBUTOR",
    body: `body ${id}`,
    createdAt,
    updatedAt: null,
    lastEditedAt: null,
    url: null,
    isMinimized: false,
    minimizedReason: null,
    ...extra,
  };
}
export function feedbackPages(
  query: string,
  vars: Record<string, string | number>,
): unknown {
  const pull = (body: unknown) => ({
    data: { repository: { pullRequest: body } },
  });
  if (query.includes("headRefOid"))
    return pull({
      number: 7,
      title: "Feedback",
      url: "https://github.com/example/project/pull/7",
      state: "OPEN",
      isDraft: false,
      author: { login: "alice" },
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "head",
      baseRefOid: "base",
    });
  if (query.includes("reviewThreads("))
    return pull({
      reviewThreads: vars.after
        ? feedbackPage([
            feedbackThread("T2", feedbackPage([feedbackComment("C3")]), 1),
          ])
        : feedbackPage(
            [
              feedbackThread(
                "T1",
                feedbackPage([feedbackComment("C1")], "c1"),
                2,
              ),
            ],
            "t1",
          ),
    });
  if (query.includes("PullRequestReviewThread"))
    return {
      data: {
        node: {
          comments: feedbackPage([
            feedbackComment("C2", {
              replyTo: { id: "C1" },
              diffHunk: "@@ -2 +2 @@",
            }),
          ]),
        },
      },
    };
  if (query.includes("comments(first:100,after:$after)"))
    return pull({
      comments: vars.after
        ? feedbackPage([entry("I2", "2026-01-04T00:00:00Z")])
        : feedbackPage([entry("I1", "2026-01-02T00:00:00Z")], "i1"),
    });
  if (query.includes("reviews("))
    return pull({
      reviews: feedbackPage([
        entry("R1", "2026-01-01T00:00:00Z", {
          body: "",
          state: "APPROVED",
          submittedAt: "2026-01-03T00:00:00Z",
          commit: { oid: "head" },
        }),
        entry("R2", "2026-01-01T00:00:00Z", { state: "PENDING" }),
        entry("R3", "2026-01-01T00:00:00Z", { body: " ", state: "COMMENTED" }),
        entry("R4", "2026-01-05T00:00:00Z", { state: "COMMENTED" }),
      ]),
    });
  throw new Error("unexpected query");
}

export function threadComment(
  id: string,
  state = "SUBMITTED",
): FeedbackThreadComment {
  return {
    id,
    databaseId: null,
    author: { login: "bob", type: "User", association: "MEMBER" },
    body: `body ${id}`,
    state,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: null,
    lastEditedAt: null,
    url: null,
    isMinimized: false,
    minimizedReason: null,
    replyTo: null,
    reviewId: null,
    reviewState: null,
    path: "src/a.ts",
    commit: "head",
    originalCommit: "head",
    line: 1,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    outdated: false,
  };
}
export function prFeedback(
  threadComments: FeedbackThreadComment[] = [threadComment("C1")],
  conversation: string[] = [],
  number = 1,
): PrFeedback {
  return {
    repo,
    pr: {
      number,
      title: "A change",
      url: null,
      state: "OPEN",
      isDraft: false,
      author: "alice",
      headRef: "feature",
      baseRef: "main",
      headSha: "head",
      baseSha: "base",
    },
    threads: [
      {
        id: "T1",
        path: "src/a.ts",
        subjectType: "LINE",
        diffSide: "RIGHT",
        startDiffSide: null,
        line: 1,
        startLine: null,
        originalLine: 1,
        originalStartLine: null,
        isResolved: false,
        isOutdated: false,
        isCollapsed: false,
        resolvedBy: null,
        commentsTotal: threadComments.length,
        diffHunk: "@@ -1 +1 @@",
        comments: threadComments,
      },
    ],
    conversation: conversation.map((id) => ({
      kind: "comment" as const,
      id,
      databaseId: null,
      author: { login: "carol", type: "User", association: "MEMBER" },
      body: `body ${id}`,
      state: null,
      createdAt: "2026-01-03T00:00:00Z",
      updatedAt: null,
      lastEditedAt: null,
      url: null,
      commit: null,
      isMinimized: false,
      minimizedReason: null,
    })),
    omittedReviews: 0,
  };
}
