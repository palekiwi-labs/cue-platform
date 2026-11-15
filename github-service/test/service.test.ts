import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { GithubService } from "../src/service.js";
import { SnapshotStore } from "../src/store.js";
import { collect } from "../src/collector.js";
import { apiReply, list } from "../src/api.js";
import { pr, repo, node, response } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

test("refresh promptly returns operations, coalesces fetches, separates completion and changes", async () => {
  const store = new SnapshotStore(":memory:", [repo]);
  const pending = deferred<{ viewer: string; prs: (typeof pr)[] }>();
  let calls = 0;
  let now = 10;
  const service = new GithubService(
    store,
    async () => {
      calls++;
      return pending.promise;
    },
    { now: () => now, cooldownMs: 100, pollMs: 1000 },
  );
  const events: string[] = [];
  service.onEvent((subject) => events.push(subject));
  try {
    assert.equal(list(service, {}).repositories[0].fetchedAt, null);
    const a = service.refresh(repo);
    const b = service.refresh(repo);
    assert.equal(calls, 1);
    assert.equal(service.operation(a.operationId).state, "pending");
    pending.resolve({ viewer: "viewer", prs: [pr] });
    await turn();
    assert.equal(service.operation(a.operationId).state, "complete");
    assert.equal(service.operation(b.operationId).state, "complete");
    assert.deepEqual(events, ["changed", "completed", "completed"]);
    const c = service.refresh(repo);
    assert.equal(calls, 1);
    now = 109;
    service.tick();
    assert.equal(calls, 1);
    now = 110;
    service.tick();
    await turn();
    assert.equal(calls, 2);
    assert.equal(
      service.operation(c.operationId).repositories[repo].changed,
      false,
    );
    assert.deepEqual(events, [
      "changed",
      "completed",
      "completed",
      "completed",
    ]);
  } finally {
    await service.close();
    store.close();
  }
});

test("page two failure preserves persisted snapshot, increments health and enforces backoff", async () => {
  const store = new SnapshotStore(":memory:", [repo]);
  store.replace(repo, "viewer", [pr], 1);
  let now = 1000;
  let calls = 0;
  const service = new GithubService(
    store,
    (r, signal) =>
      collect(
        r,
        async (_, vars) => {
          calls++;
          if (vars.cursor)
            throw new Error("private error must not be persisted");
          return response([node(2)], 2, "next");
        },
        signal,
      ),
    { now: () => now, pollMs: 1000, cooldownMs: 10 },
  );
  try {
    const id = service.refresh().operationId;
    await turn();
    assert.equal(service.operation(id).repositories[repo].state, "error");
    assert.deepEqual(store.read(repo).prs, [pr]);
    assert.equal(store.read(repo).snapshot.revision, 1);
    assert.equal(store.read(repo).snapshot.fetchedAt, 1);
    assert.equal(store.read(repo).snapshot.failures, 1);
    service.refresh();
    now = 1999;
    service.tick();
    assert.equal(calls, 2);
    now = 2000;
    service.tick();
    await turn();
    assert.equal(calls, 4);
    assert.equal(store.read(repo).snapshot.failures, 2);
    now = 3999;
    service.tick();
    assert.equal(calls, 4);
  } finally {
    await service.close();
    store.close();
  }
});

test("poll staggering, global concurrency, bounded operation retention and shutdown", async () => {
  const repos = [repo, "example/two", "example/three"];
  const store = new SnapshotStore(":memory:", repos);
  let now = 100;
  const gates = repos.map(() =>
    deferred<{ viewer: string; prs: (typeof pr)[] }>(),
  );
  const calls: string[] = [];
  const service = new GithubService(
    store,
    (r) => {
      calls.push(r);
      return gates[repos.indexOf(r)].promise;
    },
    {
      now: () => now,
      staggerMs: 10,
      concurrency: 2,
      maxOperations: 2,
      operationTtlMs: 100,
    },
  );
  try {
    service.tick();
    assert.deepEqual(calls, [repo]);
    now = 110;
    service.tick();
    assert.deepEqual(calls, repos.slice(0, 2));
    now = 120;
    service.tick();
    assert.equal(calls.length, 2);
    const a = service.refresh();
    service.refresh();
    assert.throws(() => service.refresh(), /capacity/);
    gates[0].resolve({ viewer: "viewer", prs: [] });
    await turn();
    assert.deepEqual(calls, repos);
    gates[1].resolve({ viewer: "viewer", prs: [] });
    gates[2].resolve({ viewer: "viewer", prs: [] });
    await turn();
    assert.equal(service.operation(a.operationId).state, "complete");
    const c = service.refresh(repo);
    assert.throws(() => service.operation(a.operationId), /unknown/);
    now = 221;
    assert.throws(() => service.operation(a.operationId));
    await service.close();
    await turn();
    assert.equal(service.operation(c.operationId).state, "complete");
    assert.throws(() => service.refresh(), /stopping/);
  } finally {
    await service.close();
    store.close();
  }
});

test("list pagination guards revisions and store resets; API rejects invalid requests", async () => {
  const store = new SnapshotStore(":memory:", [repo]);
  store.replace(repo, "viewer", [pr, { ...pr, number: 2 }], 1);
  const service = new GithubService(store, async () => ({
    viewer: "viewer",
    prs: [],
  }));
  try {
    const first = list(service, { limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.nextOffset, 1);
    const request = {
      offset: 1,
      limit: 1,
      storeId: first.storeId,
      revisions: { [repo]: 1 },
    };
    assert.equal(list(service, request).prs[0].number, 2);
    store.replace(repo, "viewer", [], 2);
    assert.throws(() => list(service, request), /revision/);
    assert.throws(() => list(service, { storeId: "old" }), /identity/);
    for (const [op, input] of [
      ["list", null],
      ["list", { limit: 101 }],
      ["list", { offset: -1 }],
      ["refresh", { repo: "unknown/repo" }],
      ["operation", {}],
      ["unknown", {}],
    ]) {
      assert.equal(apiReply(service, op as string, input).ok, false);
    }
    assert.equal(apiReply(service, "list", {}).ok, true);
  } finally {
    await service.close();
    store.close();
  }
});
