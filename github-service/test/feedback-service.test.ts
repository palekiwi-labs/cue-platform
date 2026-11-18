import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { RateLimitError } from "../src/collector.js";
import { apiReply, feedback, list } from "../src/api.js";
import { GithubService } from "../src/service.js";
import { SnapshotStore } from "../src/store.js";
import type { FeedbackEvent, Pr, PrFeedback } from "../src/protocol.js";
import { pr, prFeedback, repo, threadComment } from "./fixtures.js";

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await turn();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
}

test("feedback is fetched only for PRs whose updatedAt changed, and closed PRs are pruned", async () => {
  const store = new SnapshotStore(":memory:", [repo]);
  let now = 1000;
  let prs: Pr[] = [pr, { ...pr, number: 2 }];
  const comments: Record<number, string[]> = { 1: ["C1"], 2: ["C1"] };
  const calls: number[] = [];
  const events: FeedbackEvent[] = [];
  const service = new GithubService(
    store,
    async () => ({ viewer: "viewer", prs }),
    { now: () => now, pollMs: 1000, cooldownMs: 10 },
    async (_, number) => {
      calls.push(number);
      return prFeedback(
        comments[number].map((id) => threadComment(id)),
        [],
        number,
      );
    },
  );
  service.onEvent((subject, event) => {
    if (subject === "feedbackChanged") events.push(event as FeedbackEvent);
  });
  try {
    service.tick();
    await settle();
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(
      events.map((e) => [e.number, e.revision, e.newComments]),
      [
        [1, 1, []],
        [2, 1, []],
      ],
    );
    assert.equal(store.readFeedback(repo, 1).sourceUpdatedAt, pr.updatedAt);
    now += 1000;
    service.tick();
    await settle();
    assert.deepEqual(calls, [1, 2]);
    prs = [pr, { ...pr, number: 2, updatedAt: "2026-01-03T00:00:00Z" }];
    comments[2] = ["C1", "C2", "P1"];
    now += 1000;
    service.tick();
    await settle();
    assert.deepEqual(calls, [1, 2, 2]);
    assert.deepEqual(events.at(-1)?.newComments, [
      {
        id: "C2",
        kind: "thread",
        author: "bob",
        createdAt: "2026-01-02T00:00:00Z",
        threadId: "T1",
      },
      {
        id: "P1",
        kind: "thread",
        author: "bob",
        createdAt: "2026-01-02T00:00:00Z",
        threadId: "T1",
      },
    ]);
    const read = feedback(service, { repo, number: 2 });
    assert.equal(read.revision, 2);
    assert.equal(read.sourceUpdatedAt, "2026-01-03T00:00:00Z");
    assert.equal(read.feedback?.threads[0].comments.length, 3);
    prs = [pr];
    now += 1000;
    service.tick();
    await settle();
    assert.equal(store.readFeedback(repo, 2).revision, 0);
    assert.throws(() => feedback(service, { repo, number: 2 }), /not tracked/);
    assert.equal(apiReply(service, "feedback", { repo, number: 2 }).ok, false);
    assert.equal(apiReply(service, "feedback", { repo, number: 1 }).ok, true);
    for (const input of [{}, { repo }, { repo, number: 0 }, { number: 1 }])
      assert.equal(apiReply(service, "feedback", input).ok, false);
  } finally {
    await service.close();
    store.close();
  }
});

test("manual per-PR refresh bypasses updatedAt, coalesces and keeps last good data on failure", async () => {
  const store = new SnapshotStore(":memory:", [repo]);
  store.replace(repo, "viewer", [pr], 1);
  let now = 1000;
  let gate = deferred<PrFeedback>();
  let calls = 0;
  const service = new GithubService(
    store,
    async () => ({ viewer: "viewer", prs: [pr] }),
    { now: () => now, pollMs: 1000, cooldownMs: 10 },
    async () => {
      calls++;
      return gate.promise;
    },
  );
  try {
    assert.throws(() => service.refresh(undefined, 1), /requires repo/);
    assert.throws(() => service.refresh(repo, 9), /not tracked/);
    const a = service.refresh(repo, 1);
    const b = service.refresh(repo, 1);
    assert.equal(calls, 1);
    const pending = service.operation(a.operationId);
    assert.deepEqual(pending.repositories, {});
    assert.deepEqual(pending.feedback, { repo, number: 1, state: "pending" });
    gate.resolve(prFeedback());
    await settle();
    for (const op of [a, b]) {
      assert.deepEqual(service.operation(op.operationId).feedback, {
        repo,
        number: 1,
        state: "success",
        revision: 1,
        changed: true,
      });
    }
    gate = deferred<PrFeedback>();
    const c = service.refresh(repo, 1);
    await settle();
    assert.equal(calls, 1);
    now += 10;
    service.tick();
    await settle();
    assert.equal(calls, 2);
    gate.reject(new Error("page two failed"));
    await settle();
    assert.equal(service.operation(c.operationId).feedback?.state, "error");
    const failed = store.readFeedback(repo, 1);
    assert.equal(failed.failures, 1);
    assert.equal(failed.revision, 1);
    assert.deepEqual(failed.feedback, prFeedback());
    service.refresh(repo, 1);
    now += 999;
    service.tick();
    await settle();
    assert.equal(calls, 2);
    now += 1;
    service.tick();
    await settle();
    assert.equal(calls, 3);
    assert.equal(apiReply(service, "refresh", { repo, number: "1" }).ok, false);
  } finally {
    await service.close();
    store.close();
  }
});

test("rate limits pause repository and feedback collection until the reset", async () => {
  const store = new SnapshotStore(":memory:", [repo, "example/two"]);
  store.replace(repo, "viewer", [pr], 1);
  let now = 1000;
  const repoCalls: string[] = [];
  let feedbackCalls = 0;
  let limit = true;
  const service = new GithubService(
    store,
    async (r) => {
      repoCalls.push(r);
      if (limit) {
        limit = false;
        throw new RateLimitError(5000);
      }
      return { viewer: "viewer", prs: r === repo ? [pr] : [] };
    },
    { now: () => now, pollMs: 100_000, cooldownMs: 10, staggerMs: 0 },
    async () => {
      feedbackCalls++;
      return prFeedback();
    },
  );
  try {
    const op = service.refresh(repo);
    await settle();
    assert.deepEqual(repoCalls, [repo]);
    assert.equal(service.paused(), 5000);
    assert.equal(list(service, {}).pausedUntil, 5000);
    assert.equal(store.read(repo).snapshot.failures, 0);
    service.refresh(repo, 1);
    now = 4999;
    service.tick();
    await settle();
    assert.deepEqual(repoCalls, [repo]);
    assert.equal(feedbackCalls, 0);
    const pending = service.operation(op.operationId);
    assert.equal(pending.state, "pending");
    assert.equal(pending.pausedUntil, 5000);
    now = 5000;
    service.tick();
    await settle();
    assert.deepEqual(repoCalls.sort(), [repo, repo, "example/two"].sort());
    assert.equal(feedbackCalls, 1);
    assert.equal(service.paused(), null);
    assert.equal(list(service, {}).pausedUntil, null);
    const done = service.operation(op.operationId);
    assert.equal(done.state, "complete");
    assert.equal(done.repositories[repo].state, "success");
    service.pause(9000);
    assert.equal(feedback(service, { repo, number: 1 }).pausedUntil, 9000);
  } finally {
    await service.close();
    store.close();
  }
});

test("feedback jobs wait behind runnable repository polls and use their own concurrency", async () => {
  const repos = [repo, "example/two"];
  const store = new SnapshotStore(":memory:", repos);
  store.replace(repo, "viewer", [pr, { ...pr, number: 2 }], 1);
  const now = 1000;
  const repoGates = new Map<
    string,
    ReturnType<typeof deferred<{ viewer: string; prs: Pr[] }>>
  >();
  const feedbackGates: ReturnType<typeof deferred<PrFeedback>>[] = [];
  const service = new GithubService(
    store,
    (r) => {
      const gate = deferred<{ viewer: string; prs: Pr[] }>();
      repoGates.set(r, gate);
      return gate.promise;
    },
    { now: () => now, concurrency: 1, staggerMs: 0, cooldownMs: 10 },
    async () => {
      const gate = deferred<PrFeedback>();
      feedbackGates.push(gate);
      return gate.promise;
    },
  );
  try {
    service.tick();
    service.refresh(repo, 1);
    service.refresh(repo, 2);
    await settle();
    assert.equal(repoGates.size, 1);
    assert.equal(feedbackGates.length, 0);
    repoGates
      .get(repo)!
      .resolve({ viewer: "viewer", prs: [pr, { ...pr, number: 2 }] });
    await settle();
    assert.equal(repoGates.size, 2);
    assert.equal(feedbackGates.length, 1);
    feedbackGates[0].resolve(prFeedback());
    await settle();
    assert.equal(feedbackGates.length, 2);
    repoGates.get("example/two")!.resolve({ viewer: "viewer", prs: [] });
    feedbackGates[1].resolve(prFeedback([], [], 2));
    await settle();
    assert.equal(store.readFeedback(repo, 2).revision, 1);
  } finally {
    await service.close();
    store.close();
  }
});
