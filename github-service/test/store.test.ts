import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SnapshotStore } from "../src/store.js";
import { pr, prFeedback, repo, threadComment } from "./fixtures.js";

test("persist snapshots and health privately, retain revisions on unchanged data", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-store-"));
  const path = join(dir, "private", "snapshots.sqlite");
  let store = new SnapshotStore(path, [repo]);
  try {
    assert.equal(store.read(repo).snapshot.revision, 0);
    assert.equal(store.read(repo).snapshot.fetchedAt, null);
    assert.deepEqual(store.read(repo).prs, []);
    assert.deepEqual(store.replace(repo, "viewer", [pr], 10), {
      changed: true,
      revision: 1,
    });
    store.failed(repo, 20);
    assert.equal(store.read(repo).snapshot.failures, 1);
    assert.equal(store.read(repo).snapshot.fetchedAt, 10);
    assert.deepEqual(store.read(repo).prs, [pr]);
    const id = store.storeId;
    store.close();
    store = new SnapshotStore(path, [repo]);
    assert.equal(store.storeId, id);
    assert.deepEqual(store.replace(repo, "viewer", [pr], 30), {
      changed: false,
      revision: 1,
    });
    assert.equal(store.read(repo).snapshot.error, null);
    assert.equal(store.read(repo).snapshot.failures, 0);
    assert.deepEqual(store.replace(repo, "other-viewer", [pr], 40), {
      changed: true,
      revision: 2,
    });
    assert.throws(() => store.replace(repo, "viewer", [pr, pr], 50));
    assert.equal(store.read(repo).snapshot.revision, 2);
    assert.deepEqual(store.replace(repo, "other-viewer", [], 60), {
      changed: true,
      revision: 3,
    });
    assert.deepEqual(store.read(repo).prs, []);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical ordering does not create spurious revisions", () => {
  const store = new SnapshotStore(":memory:", [repo]);
  try {
    const a = { ...pr, labels: ["z", "a"], reviewers: ["b", "a"] };
    store.replace(repo, "viewer", [a, { ...pr, number: 2 }], 1);
    assert.equal(
      store.replace(
        repo,
        "viewer",
        [
          { ...pr, number: 2 },
          { ...a, labels: ["a", "z"], reviewers: ["a", "b"] },
        ],
        2,
      ).changed,
      false,
    );
    assert.throws(() => store.read("unconfigured/repo"));
  } finally {
    store.close();
  }
});

test("SQLite write failure rolls back the snapshot and permits later recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-rollback-"));
  const path = join(dir, "snapshots.sqlite");
  const store = new SnapshotStore(path, [repo]);
  const fault = new DatabaseSync(path);
  try {
    store.replace(repo, "viewer", [pr], 10);
    fault.exec(`CREATE TRIGGER fail_snapshot BEFORE UPDATE ON snapshots
      WHEN NEW.payload != OLD.payload BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    assert.throws(() => store.replace(repo, "viewer", [], 20));
    assert.deepEqual(store.read(repo).prs, [pr]);
    assert.equal(store.read(repo).snapshot.revision, 1);
    assert.equal(store.read(repo).snapshot.fetchedAt, 10);
    fault.exec("DROP TRIGGER fail_snapshot");
    assert.equal(store.replace(repo, "viewer", [], 30).revision, 2);
  } finally {
    fault.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feedback revisions, baseline, new comments without PENDING, pruning", () => {
  const store = new SnapshotStore(":memory:", [repo]);
  try {
    assert.equal(store.readFeedback(repo, 1).feedback, null);
    assert.throws(() =>
      store.replaceFeedback(repo, 1, prFeedback(), pr.updatedAt, 1),
    );
    store.replace(repo, "viewer", [pr, { ...pr, number: 2 }], 1);
    store.feedbackFailed(repo, 1, 2);
    assert.equal(store.readFeedback(repo, 1).failures, 1);
    assert.equal(store.readFeedback(repo, 1).revision, 0);
    assert.deepEqual(
      store.replaceFeedback(
        repo,
        1,
        prFeedback([threadComment("C1")], ["I1"]),
        "u1",
        3,
      ),
      { revision: 1, changed: true, newComments: [] },
    );
    const saved = store.readFeedback(repo, 1);
    assert.equal(saved.sourceUpdatedAt, "u1");
    assert.equal(saved.failures, 0);
    assert.equal(saved.error, null);
    assert.equal(saved.fetchedAt, 3);
    assert.deepEqual(saved.feedback, prFeedback([threadComment("C1")], ["I1"]));
    assert.deepEqual(
      store.replaceFeedback(
        repo,
        1,
        prFeedback([threadComment("C1")], ["I1"]),
        "u2",
        4,
      ),
      { revision: 1, changed: false, newComments: [] },
    );
    assert.equal(store.readFeedback(repo, 1).sourceUpdatedAt, "u2");
    const withNew = prFeedback(
      [
        threadComment("C1"),
        threadComment("C2"),
        threadComment("P1", "PENDING"),
      ],
      ["I1", "I2"],
    );
    assert.deepEqual(store.replaceFeedback(repo, 1, withNew, "u3", 5), {
      revision: 2,
      changed: true,
      newComments: [
        {
          id: "C2",
          kind: "thread",
          author: "bob",
          createdAt: "2026-01-02T00:00:00Z",
          threadId: "T1",
        },
        {
          id: "I2",
          kind: "comment",
          author: "carol",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
    });
    store.feedbackFailed(repo, 1, 6);
    const failed = store.readFeedback(repo, 1);
    assert.equal(failed.failures, 1);
    assert.equal(failed.error, "GitHub collection failed");
    assert.equal(failed.revision, 2);
    assert.deepEqual(failed.feedback, withNew);
    const submitted = prFeedback(
      [threadComment("C1"), threadComment("C2"), threadComment("P1")],
      ["I1", "I2"],
    );
    assert.deepEqual(
      store
        .replaceFeedback(repo, 1, submitted, "u4", 7)
        .newComments.map((c) => c.id),
      ["P1"],
    );
    store.replaceFeedback(repo, 2, prFeedback([], [], 2), "u1", 8);
    assert.throws(() =>
      store.replaceFeedback(repo, 2, prFeedback([], [], 3), "u1", 8),
    );
    store.replace(repo, "viewer", [{ ...pr, number: 2 }], 9);
    assert.equal(store.readFeedback(repo, 1).feedback, null);
    assert.equal(store.readFeedback(repo, 1).revision, 0);
    assert.equal(store.readFeedback(repo, 2).revision, 1);
    store.feedbackAttempted(repo, 1, 10);
    assert.equal(store.readFeedback(repo, 1).attemptedAt, null);
    assert.throws(() => store.readFeedback("unconfigured/repo", 1));
  } finally {
    store.close();
  }
});
