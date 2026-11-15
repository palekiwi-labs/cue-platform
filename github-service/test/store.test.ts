import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/store.js";
import { pr, repo } from "./fixtures.js";

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
