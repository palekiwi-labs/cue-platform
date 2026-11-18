import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { serveNats } from "../src/nats.js";
import { GithubClient } from "../src/client.js";
import { GithubService } from "../src/service.js";
import { SnapshotStore } from "../src/store.js";
import {
  SUBJECTS,
  type FeedbackEvent,
  type ListResult,
  type RefreshOperation,
  type Reply,
} from "../src/protocol.js";
import { pr, prFeedback, repo, threadComment } from "./fixtures.js";

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {}
    await sleep(30);
  }
  throw new Error("condition timed out");
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function client(url: string): Promise<NatsConnection> {
  return eventually(
    () => connect({ servers: url, reconnect: false, timeout: 200 }),
    () => true,
  );
}

test(
  "UI client restarts guarded pagination on conflict and collects every page",
  { timeout: 10_000 },
  async () => {
    const port = await unusedPort();
    const url = `nats://127.0.0.1:${port}`;
    const server = spawn(
      "nats-server",
      ["-a", "127.0.0.1", "-p", String(port)],
      { stdio: "ignore" },
    );
    const ui = new GithubClient(url);
    let nc: NatsConnection | undefined;
    let reading: Promise<void> | undefined;
    try {
      nc = await client(url);
      const subscription = nc.subscribe(SUBJECTS.list);
      let conflicted = false;
      const offsets: number[] = [];
      reading = (async () => {
        for await (const msg of subscription) {
          const request = msg.json<{
            offset?: number;
            revisions?: Record<string, number>;
            storeId?: string;
          }>();
          const offset = request.offset ?? 0;
          offsets.push(offset);
          if (offset > 0 && !conflicted) {
            conflicted = true;
            msg.respond(
              JSON.stringify({
                ok: false,
                error: { code: "conflict", message: "changed" },
              }),
            );
            continue;
          }
          if (offset > 0) {
            assert.equal(request.storeId, "fixture-store");
            assert.equal(request.revisions?.[repo], 2);
          }
          msg.respond(
            JSON.stringify({
              ok: true,
              data: {
                storeId: "fixture-store",
                total: 101,
                repositories: [{ repo, revision: conflicted ? 2 : 1 }],
                prs: Array.from(
                  { length: Math.min(50, 101 - offset) },
                  (_, i) => ({ ...pr, number: offset + i + 1 }),
                ),
                nextOffset: offset + 50 < 101 ? offset + 50 : null,
              },
            }),
          );
        }
      })();
      await nc.flush();
      const result = await ui.list(repo);
      assert.equal(result.prs.length, 101);
      assert.equal(new Set(result.prs.map((p) => p.number)).size, 101);
      assert.deepEqual(offsets, [0, 50, 0, 50, 100]);
      assert.equal(result.repositories[0].revision, 2);
      subscription.unsubscribe();
      await reading;
    } finally {
      await ui.close();
      await nc?.close();
      await reading;
      await stop(server);
    }
  },
);

test(
  "NATS initial outage, API lifecycle, advisory events, reconnect and offline polling",
  { timeout: 25_000 },
  async () => {
    const port = await unusedPort();
    const url = `nats://127.0.0.1:${port}`;
    const store = new SnapshotStore(":memory:", [repo]);
    let version = 1;
    let now = 1000;
    const service = new GithubService(
      store,
      async () => ({
        viewer: "viewer",
        prs: [{ ...pr, title: `version ${version}` }],
      }),
      { now: () => now, cooldownMs: 10, pollMs: 100 },
    );
    const abort = new AbortController();
    const serving = serveNats(service, url, abort.signal);
    let server: ChildProcess | undefined;
    let nc: NatsConnection | undefined;
    const ui = new GithubClient(url);
    try {
      service.tick();
      await eventually(
        async () => store.read(repo).snapshot.revision,
        (r) => r === 1,
      );
      server = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], {
        stdio: "ignore",
      });
      nc = await client(url);
      const request = async <T>(
        subject: string,
        input: unknown,
      ): Promise<Reply<T>> =>
        (
          await nc!.request(subject, JSON.stringify(input), { timeout: 300 })
        ).json();
      const initial = await eventually(
        () => request<ListResult>(SUBJECTS.list, {}),
        (r) => r.ok,
      );
      assert.equal(initial.ok && initial.data.prs[0].title, "version 1");
      assert.equal((await ui.list(repo)).prs[0].title, "version 1");
      let hints = 0;
      const unwatch = ui.watch(() => hints++);
      const completed = nc.subscribe(SUBJECTS.completed);
      const changed = nc.subscribe(SUBJECTS.changed);
      const completionEvents: unknown[] = [];
      const changeEvents: unknown[] = [];
      const readingCompleted = (async () => {
        for await (const msg of completed) completionEvents.push(msg.json());
      })();
      const readingChanged = (async () => {
        for await (const msg of changed) changeEvents.push(msg.json());
      })();
      await nc.flush();
      now += 10;
      const refresh = await request<{ operationId: string }>(SUBJECTS.refresh, {
        repo,
      });
      assert.equal(refresh.ok, true);
      const operationId = refresh.ok ? refresh.data.operationId : "";
      const op = await eventually(
        () => request<RefreshOperation>(SUBJECTS.operation, { operationId }),
        (r) => r.ok && r.data.state === "complete",
      );
      assert.equal(op.ok && op.data.repositories[repo].changed, false);
      await eventually(
        async () => completionEvents.length,
        (n) => n === 1,
      );
      assert.equal(changeEvents.length, 0);
      version = 2;
      now += 100;
      service.tick();
      await eventually(
        async () => changeEvents.length,
        (n) => n === 1,
      );
      assert.equal((changeEvents[0] as { revision: number }).revision, 2);
      await eventually(
        async () => hints,
        (n) => n > 0,
      );
      now += 10;
      assert.equal((await ui.refresh(repo)).repositories[repo].changed, false);
      unwatch();
      const malformed = (
        await nc.request(SUBJECTS.list, "{", { timeout: 300 })
      ).json<Reply<unknown>>();
      assert.equal(malformed.ok, false);
      await stop(server);
      await nc.closed();
      completed.unsubscribe();
      changed.unsubscribe();
      await Promise.all([readingCompleted, readingChanged]);
      version = 3;
      now += 100;
      service.tick();
      await eventually(
        async () => store.read(repo).snapshot.revision,
        (r) => r === 3,
      );
      server = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], {
        stdio: "ignore",
      });
      nc = await client(url);
      const after = await eventually(
        () => request<ListResult>(SUBJECTS.list, {}),
        (r) => r.ok && r.data.repositories[0].revision === 3,
      );
      assert.equal(after.ok && after.data.prs[0].title, "version 3");
      const recovered = await eventually(
        () => ui.list(repo),
        (data) => data.repositories[0].revision === 3,
      );
      assert.equal(recovered.prs[0].title, "version 3");
      assert.equal(
        after.ok && initial.ok && after.data.storeId,
        initial.ok && initial.data.storeId,
      );
    } finally {
      await ui.close();
      abort.abort();
      await serving;
      await nc?.close();
      if (server) await stop(server);
      await service.close();
      store.close();
    }
  },
);

test(
  "NATS feedback read, per-PR refresh, feedback events and size limit",
  { timeout: 15_000 },
  async () => {
    const port = await unusedPort();
    const url = `nats://127.0.0.1:${port}`;
    const dir = mkdtempSync(join(tmpdir(), "github-nats-"));
    const conf = join(dir, "nats.conf");
    writeFileSync(conf, "max_payload: 65536\n");
    const server = spawn(
      "nats-server",
      ["-a", "127.0.0.1", "-p", String(port), "-c", conf],
      { stdio: "ignore" },
    );
    const store = new SnapshotStore(":memory:", [repo]);
    store.replace(repo, "viewer", [pr, { ...pr, number: 2 }], 1);
    let now = 1000;
    let ids = ["C1"];
    let gate: Promise<void> = Promise.resolve();
    const service = new GithubService(
      store,
      async () => ({ viewer: "viewer", prs: [pr, { ...pr, number: 2 }] }),
      { now: () => now, cooldownMs: 10, pollMs: 100_000 },
      async (_, number) => {
        await gate;
        return number === 2
          ? prFeedback(
              [{ ...threadComment("C9"), body: "x".repeat(70_000) }],
              [],
              2,
            )
          : prFeedback(ids.map((id) => threadComment(id)));
      },
    );
    const abort = new AbortController();
    const ui = new GithubClient(url);
    let nc: NatsConnection | undefined;
    let serving: Promise<void> | undefined;
    try {
      nc = await client(url);
      serving = serveNats(service, url, abort.signal);
      const events: FeedbackEvent[] = [];
      const off = ui.onFeedback((event) => events.push(event));
      const empty = await eventually(
        () => ui.feedback(repo, 1),
        () => true,
      );
      assert.equal(empty.revision, 0);
      assert.equal(empty.feedback, null);
      assert.equal(empty.pausedUntil, null);
      await assert.rejects(ui.feedback(repo, 9), { code: "not_found" });
      const first = await ui.refreshFeedback(repo, 1);
      assert.equal(first.feedback?.state, "success");
      assert.deepEqual(first.repositories, {});
      const read = await ui.feedback(repo, 1);
      assert.equal(read.revision, 1);
      assert.equal(read.feedback?.threads[0].comments[0].id, "C1");
      await eventually(
        async () => events.length,
        (n) => n === 1,
      );
      assert.deepEqual(events[0].newComments, []);
      ids = ["C1", "C2"];
      now += 10;
      await ui.refreshFeedback(repo, 1);
      await eventually(
        async () => events.length,
        (n) => n === 2,
      );
      assert.equal(events[1].revision, 2);
      assert.equal(events[1].number, 1);
      assert.deepEqual(
        events[1].newComments.map((c) => c.id),
        ["C2"],
      );
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      now += 10;
      const progress: string[] = [];
      const held = await ui.refreshFeedback(repo, 1, (op) => {
        progress.push(op.feedback?.state ?? "none");
        release();
      });
      assert.equal(held.feedback?.state, "success");
      assert.equal(progress[0], "pending");
      off();
      await ui.refreshFeedback(repo, 2);
      await assert.rejects(ui.feedback(repo, 2), {
        code: "response_too_large",
      });
      const legacy = await ui.refresh(repo);
      assert.equal(legacy.repositories[repo].state, "success");
      assert.equal(legacy.feedback, undefined);
    } finally {
      await ui.close();
      abort.abort();
      await serving;
      await nc?.close();
      await stop(server);
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
