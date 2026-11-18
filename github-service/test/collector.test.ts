import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, type Graphql } from "../src/collector.js";
import { connection, node, pr, repo, response } from "./fixtures.js";

test("collect all PR pages and nested connections with credential viewer", async () => {
  const first = node();
  first.labels = connection([{ name: "bug" }], 2, "label-page");
  first.reviewRequests = connection(
    [{ requestedReviewer: { login: "bob" } }],
    2,
    "review-page",
  );
  const calls: Record<string, string | number>[] = [];
  const graphql: Graphql = async (query, variables) => {
    calls.push(variables);
    if (query.includes("node(id:")) {
      return {
        data: {
          node: query.includes("labels(")
            ? { labels: connection([{ name: "feature" }], 2) }
            : { reviewRequests: connection([{ requestedReviewer: {} }], 2) },
        },
      };
    }
    return variables.cursor
      ? response([node(2)], 2)
      : response([first], 2, "pr-page");
  };
  const result = await collect(repo, graphql);
  assert.equal(result.viewer, "viewer");
  assert.deepEqual(result.prs[0], { ...pr, labels: ["bug", "feature"] });
  assert.equal(result.prs.length, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1)?.cursor, "pr-page");
  assert.equal(calls[1].credentialOwner, "example");
});

test("reject failures, partial GraphQL data, malformed pages and repeated cursors", async () => {
  await assert.rejects(
    collect(repo, async () => ({
      errors: [{ message: "partial" }],
      ...response([]),
    })),
  );
  await assert.rejects(
    collect(repo, async () => ({ data: { repository: null } })),
  );
  await assert.rejects(collect(repo, async () => response([node()], 2)));
  await assert.rejects(
    collect(repo, async (_, vars) => {
      if (vars.cursor) throw new Error("page two failed");
      return response([node()], 2, "next");
    }),
  );
  await assert.rejects(
    collect(repo, async (_, vars) =>
      response([node(vars.cursor ? 2 : 1)], 3, "same"),
    ),
  );
  await assert.rejects(
    collect(repo, async (_, vars) =>
      response(
        [node(vars.cursor ? 2 : 1)],
        vars.cursor ? 3 : 2,
        vars.cursor ? null : "next",
      ),
    ),
  );
  await assert.rejects(
    collect(repo, async () =>
      response([{ ...node(), labels: connection([{ name: "bug" }], 2) }]),
    ),
  );
});

test("empty repositories are valid complete snapshots", async () => {
  assert.deepEqual(await collect(repo, async () => response([])), {
    viewer: "viewer",
    prs: [],
  });
});
