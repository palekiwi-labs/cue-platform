import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  feedbackCachePath,
  feedbackCommand,
  fetchFeedback,
  type Graphql,
  type GraphqlVars,
  loadSnapshot,
  paginate,
} from "../src/github-feedback.js";

const page = (nodes: unknown[], next: string | null, total?: number) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  ...(total === undefined ? {} : { totalCount: total }),
});

const rc = (id: string, over: Record<string, unknown> = {}) => ({
  id, fullDatabaseId: 100, author: { login: "alice", __typename: "User" }, authorAssociation: "MEMBER",
  body: `body ${id}`, state: "SUBMITTED", createdAt: `2025-01-01T00:00:0${id.slice(-1)}Z`, updatedAt: null,
  lastEditedAt: null, url: `https://x/${id}`, isMinimized: false, minimizedReason: null, replyTo: null,
  pullRequestReview: { id: "PRR1", state: "COMMENTED" }, path: "a.ts", commit: { oid: "c".repeat(40) },
  originalCommit: { oid: "o".repeat(40) }, line: 3, originalLine: 2, startLine: null, originalStartLine: null,
  outdated: false, diffHunk: "@@ -1 +1 @@\n+x", ...over,
});

const pr = (body: Record<string, unknown>) => ({ repository: { pullRequest: body } });

function fakeGithub() {
  const calls: { query: string; vars: GraphqlVars }[] = [];
  const gql: Graphql = async (query, vars) => {
    calls.push({ query, vars });
    const after = vars.after;
    if (query.includes("headRefOid")) {
      return pr({ number: 7, title: "T", url: "u", state: "OPEN", isDraft: false, author: { login: "bob" },
        headRefName: "h", baseRefName: "main", headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40) });
    }
    if (query.includes("node(id")) {
      return { node: { comments: page([rc("c3", { replyTo: { id: "c1" } })], null) } };
    }
    if (query.includes("reviewThreads")) {
      const t1 = { id: "T1", path: "a.ts", subjectType: "LINE", diffSide: "RIGHT", line: 3, originalLine: 2,
        isResolved: true, isOutdated: false, isCollapsed: true, resolvedBy: { login: "bob" },
        comments: page([rc("c1"), rc("c2", { replyTo: { id: "c1" } })], "tc1", 3) };
      const t2 = { id: "T2", path: "b.ts", subjectType: "LINE", diffSide: "LEFT", line: null, originalLine: 9,
        isResolved: false, isOutdated: true, comments: page([rc("c4", { author: null })], null, 1) };
      return pr({ reviewThreads: after === undefined ? page([t1], "p1") : page([t2], null) });
    }
    if (query.includes("reviews(")) {
      const review = (id: string, state: string, body: string, at: string) => ({
        id, fullDatabaseId: "9007199254740993", author: { login: "carol", __typename: "User" }, body, state,
        createdAt: at, submittedAt: at, url: id, commit: { oid: "h".repeat(40) },
      });
      return pr({ reviews: page([
        review("R1", "COMMENTED", "", "2025-01-01T00:00:05Z"),
        review("R2", "APPROVED", "", "2025-01-03T00:00:00Z"),
        review("R3", "CHANGES_REQUESTED", "fix it", "2025-01-01T00:00:00Z"),
        review("R4", "PENDING", "draft", "2025-01-04T00:00:00Z"),
      ], null) });
    }
    if (query.includes("comments(first: 100, after: $after)")) {
      return pr({ comments: page([{ id: "IC1", fullDatabaseId: 5, author: { login: "dave", __typename: "Bot" },
        body: "general", createdAt: "2025-01-02T00:00:00Z", url: "ic", isMinimized: true, minimizedReason: "OUTDATED" }], null) });
    }
    throw new Error(`unexpected query ${query}`);
  };
  return { gql, calls };
}

test("fetchFeedback paginates threads and thread comments and keeps grouping and metadata", async () => {
  const { gql, calls } = fakeGithub();
  const s = await fetchFeedback(gql, "org/repo", 7, () => new Date("2025-02-01T00:00:00Z"));
  assert.equal(s.schema, "station/github-feedback@1");
  assert.equal(s.fetched_at, "2025-02-01T00:00:00.000Z");
  assert.deepEqual(s.pr, { number: 7, title: "T", url: "u", state: "OPEN", is_draft: false, author: "bob",
    head_ref: "h", base_ref: "main", head_sha: "h".repeat(40), base_sha: "b".repeat(40) });
  assert.deepEqual(s.threads.map((t) => [t.id, t.comments.map((c) => c.id), t.comments_total]), [
    ["T1", ["c1", "c2", "c3"], 3],
    ["T2", ["c4"], 1],
  ]);
  const [t1, t2] = s.threads;
  assert.equal(t1?.is_resolved, true);
  assert.equal(t1?.resolved_by, "bob");
  assert.equal(t1?.comments[2]?.reply_to, "c1");
  assert.equal(t1?.comments[0]?.original_commit, "o".repeat(40));
  assert.equal(t1?.comments[0]?.database_id, "100");
  assert.equal(t2?.diff_side, "LEFT");
  assert.equal(t2?.is_outdated, true);
  assert.equal(t2?.comments[0]?.author.login, null);
  const threadCalls = calls.filter((c) => c.query.includes("reviewThreads"));
  assert.deepEqual(threadCalls.map((c) => c.vars.after), [undefined, "p1"]);
  assert.deepEqual(calls.find((c) => c.query.includes("node(id"))?.vars, { id: "T1", after: "tc1" });
  assert.deepEqual(threadCalls[0]?.vars, { owner: "org", name: "repo", number: 7 });
});

test("conversation keeps comments and review bodies in time order and drops empty or pending reviews", async () => {
  const s = await fetchFeedback(fakeGithub().gql, "org/repo", 7);
  assert.deepEqual(s.conversation.map((e) => [e.kind, e.id, e.state]), [
    ["review", "R3", "CHANGES_REQUESTED"],
    ["comment", "IC1", null],
    ["review", "R2", "APPROVED"],
  ]);
  assert.equal(s.omitted_reviews, 2);
  assert.equal(s.conversation[0]?.database_id, "9007199254740993");
  assert.equal(s.conversation[1]?.is_minimized, true);
  assert.equal(s.conversation[1]?.author.type, "Bot");
});

test("paginate fails on a repeated cursor and on a missing list", async () => {
  const looping: Graphql = async () => ({ c: page([1], "same") });
  await assert.rejects(paginate(looping, "q", {}, (d) => (d as { c: unknown }).c, "things"), /no new cursor/);
  const broken: Graphql = async () => ({ c: { pageInfo: {} } });
  await assert.rejects(paginate(broken, "q", {}, (d) => (d as { c: unknown }).c, "things"), /no things list/);
  const missing: Graphql = async () => ({ repository: { pullRequest: null } });
  await assert.rejects(fetchFeedback(missing, "org/repo", 7), /no pull request/);
  await assert.rejects(fetchFeedback(missing, "not a repo", 7), /owner>\/<name/);
});

test("snapshots round-trip through --out, and unreadable ones are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-feedback-cli-"));
  try {
    const out: string[] = [];
    const deps = { gql: fakeGithub().gql, defaultRepo: () => "org/repo", stdout: (t: string) => out.push(t) };
    const file = join(dir, "s.json");
    assert.equal(await feedbackCommand(["7", "--out", file], deps), 0);
    assert.equal(out.join(""), `${file}\n`);
    assert.equal(loadSnapshot(file)?.threads.length, 2);
    await feedbackCommand(["7"], deps);
    assert.equal(JSON.parse(out.at(-1)!).pr.number, 7);
    await assert.rejects(feedbackCommand(["x"], deps), /usage: station github-feedback/);
    await assert.rejects(feedbackCommand(["7", "--save", "--out", file], deps), /either/);
    await assert.rejects(feedbackCommand(["7"], { ...deps, defaultRepo: () => null }), /--repo/);
    assert.equal(loadSnapshot(join(dir, "none.json")), null);
    writeFileSync(file, JSON.stringify({ schema: "other" }));
    assert.throws(() => loadSnapshot(file), /not a station\/github-feedback@1/);
    assert.match(feedbackCachePath("Org/Repo", 7), /github-feedback\/org-repo-pr-7\.json$/);
    assert.ok(readFileSync(join(dir, "s.json"), "utf8").length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
