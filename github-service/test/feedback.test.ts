import { test } from "node:test";
import assert from "node:assert/strict";
import type { Graphql } from "../src/collector.js";
import {
  collectFeedback,
  COMMENTS_QUERY,
  META_QUERY,
  REVIEWS_QUERY,
  THREAD_COMMENTS_QUERY,
  THREADS_QUERY,
} from "../src/feedback.js";
import { feedbackPages, repo } from "./fixtures.js";

function page(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}
function pr(body: Record<string, unknown>) {
  return { data: { repository: { pullRequest: body } } };
}

test("feedback follows every connection and stores one diff hunk per thread", async () => {
  const calls: [string, Record<string, string | number>][] = [];
  const graphql: Graphql = async (query, vars) => {
    calls.push([query, vars]);
    return feedbackPages(query, vars);
  };
  const result = await collectFeedback(repo, 7, graphql);
  assert.deepEqual(
    calls.map(([q, v]) => [
      [
        META_QUERY,
        THREADS_QUERY,
        THREAD_COMMENTS_QUERY,
        COMMENTS_QUERY,
        REVIEWS_QUERY,
      ].indexOf(q),
      v.after ?? null,
    ]),
    [
      [0, null],
      [1, null],
      [1, "t1"],
      [2, "c1"],
      [3, null],
      [3, "i1"],
      [4, null],
    ],
  );
  assert.equal(calls[1][1].number, 7);
  assert.equal(calls[3][1].credentialOwner, "example");
  assert.deepEqual(result.pr, {
    number: 7,
    title: "Feedback",
    url: "https://github.com/example/project/pull/7",
    state: "OPEN",
    isDraft: false,
    author: "alice",
    headRef: "feature",
    baseRef: "main",
    headSha: "head",
    baseSha: "base",
  });
  assert.deepEqual(
    result.threads.map((t) => [t.id, t.comments.map((c) => c.id)]),
    [
      ["T1", ["C1", "C2"]],
      ["T2", ["C3"]],
    ],
  );
  const [t1] = result.threads;
  assert.equal(t1.diffHunk, "@@ -1 +1 @@");
  assert.equal("diffHunk" in t1.comments[0], false);
  assert.equal(t1.comments[1].diffHunk, "@@ -2 +2 @@");
  assert.equal(t1.commentsTotal, 2);
  assert.equal(t1.comments[1].replyTo, "C1");
  assert.equal(t1.comments[0].databaseId, "101");
  assert.deepEqual(t1.comments[0].author, {
    login: "bob",
    type: "User",
    association: "MEMBER",
  });
  assert.deepEqual(
    result.conversation.map((e) => [e.kind, e.id, e.state]),
    [
      ["comment", "I1", null],
      ["review", "R1", "APPROVED"],
      ["comment", "I2", null],
      ["review", "R4", "COMMENTED"],
    ],
  );
  assert.equal(result.conversation[1].createdAt, "2026-01-03T00:00:00Z");
  assert.equal(result.omittedReviews, 2);
});

test("feedback rejects missing PRs, GraphQL errors and broken cursors", async () => {
  const meta = (query: string, vars: Record<string, string | number>) =>
    feedbackPages(query, vars);
  await assert.rejects(
    collectFeedback(repo, 7, async (q) =>
      q === META_QUERY ? pr(null as never) : {},
    ),
  );
  await assert.rejects(
    collectFeedback(repo, 7, async (q, v) =>
      q === THREADS_QUERY
        ? { errors: [{ message: "partial" }], ...(meta(q, v) as object) }
        : meta(q, v),
    ),
  );
  await assert.rejects(
    collectFeedback(repo, 7, async (q, v) =>
      q === COMMENTS_QUERY
        ? pr({ comments: page([], v.after ? "same" : "same") })
        : meta(q, v),
    ),
  );
  await assert.rejects(
    collectFeedback(repo, 7, async (q, v) =>
      q === REVIEWS_QUERY
        ? pr({
            reviews: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          })
        : meta(q, v),
    ),
  );
  await assert.rejects(
    collectFeedback(repo, 7, async (q, v) => {
      if (q === THREAD_COMMENTS_QUERY) throw new Error("page two failed");
      return meta(q, v);
    }),
  );
  await assert.rejects(
    collectFeedback(repo, 8, async (q, v) => meta(q, v)),
    /Unexpected pull request/,
  );
});
