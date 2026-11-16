import { test } from "node:test";
import assert from "node:assert/strict";
import { PrsSource } from "../src/prs-source.js";
import { fromDemo } from "../src/source.js";
import type { ListResult } from "../../github-service/src/protocol.js";

test("list source reads snapshots, refreshes via service, retains health and viewer", async () => {
  const source = new PrsSource("o/r");
  const calls: string[] = [];
  const data: ListResult = {
    storeId: "store", total: 1, nextOffset: null,
    repositories: [{ repo: "o/r", viewer: "viewer", revision: 1, fetchedAt: 1000, attemptedAt: 1000, failures: 0, error: null }],
    prs: [{ repo: "o/r", number: 1, title: "PR", url: "https://github.com/o/r/pull/1", author: "author", isDraft: false,
      createdAt: "2026-01-01", updatedAt: "2026-01-02", reviewDecision: null, checks: null, baseRef: "main", headRef: "feature",
      defaultBranch: "main", reviewers: ["viewer"], labels: [] }],
  };
  source.client.list = async (repo) => { calls.push(`list:${repo}`); return data; };
  source.client.refresh = async (repo) => {
    calls.push(`refresh:${repo}`);
    return { operationId: "op", createdAt: 0, completedAt: 1, state: "complete", repositories: {} };
  };
  const first = await source.load();
  assert.deepEqual(calls, ["list:o/r"]);
  assert.equal(first.viewer, "viewer");
  assert.deepEqual(first.prs[0]?.requested, ["viewer"]);
  assert.equal(first.prs[0]?.url, "https://github.com/o/r/pull/1");
  assert.equal(first.prs[0]?.createdAt, "2026-01-01");
  assert.equal(first.prs[0]?.updatedAt, "2026-01-02");
  assert.equal(first.healthy, true);
  await source.load(true);
  assert.deepEqual(calls, ["list:o/r", "refresh:o/r", "list:o/r"]);
  data.repositories[0]!.error = "collection failed";
  const failed = await source.load();
  assert.equal(failed.healthy, false);
  assert.match(failed.note, /collection failed/);
  assert.equal(failed.prs.length, 1);
  await source.client.close();
});

test("demo resolves its fixture from the shared-source build layout", () => {
  assert.ok(fromDemo().packet.files.length > 0);
});
