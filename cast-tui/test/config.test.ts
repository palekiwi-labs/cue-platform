import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  type CommandAction,
  ConfigError,
  configActions,
  outputTail,
  parseConfig,
  prEnv,
  runCommand,
} from "../src/config.js";
import { exec, type Exec } from "../src/exec.js";
import type { Pr } from "../src/picker/prs/model.js";

const PR = {
  repo: "acme/api",
  number: 7,
  headRef: "fix-it",
  url: "https://github.com/acme/api/pull/7",
} as Pr;

const DEPLOY: CommandAction = {
  key: "d",
  label: "deploy staging",
  command: "task deploy:staging",
  confirm: true,
};

const CONFIG = JSON.stringify({
  prActions: [
    {
      key: "d",
      label: "deploy staging",
      command: "task deploy:staging",
      confirm: true,
    },
  ],
});

test("parses prActions", () => {
  assert.deepEqual(parseConfig(CONFIG), { prActions: [DEPLOY] });
});

test("confirm defaults to false and prActions to none", () => {
  const text = '{"prActions":[{"key":"t","label":"test","command":"make"}]}';
  assert.equal(parseConfig(text).prActions[0]?.confirm, false);
  assert.deepEqual(parseConfig("{}"), { prActions: [] });
});

test("rejects malformed configs", () => {
  for (const text of [
    "not json",
    "[]",
    '{"prActions":{}}',
    '{"prActions":[1]}',
    '{"prActions":[{"key":"d","label":"x"}]}',
    '{"prActions":[{"key":"","label":"x","command":"y"}]}',
    '{"prActions":[{"key":"d","label":"x","command":"y","confirm":"yes"}]}',
  ]) {
    assert.throws(() => parseConfig(text), ConfigError, text);
  }
});

test("PR environment", () => {
  assert.deepEqual(prEnv(PR), {
    PR_NUMBER: "7",
    PR_URL: "https://github.com/acme/api/pull/7",
    PR_BRANCH: "fix-it",
    PR_REPO: "acme/api",
  });
});

test("output tail is the last non-empty line", () => {
  assert.equal(outputTail("a\nb\n\n", ""), "b");
  assert.equal(outputTail("a\n", "warn\n"), "warn");
  assert.equal(outputTail("", ""), "");
});

const roots = ["/code/acme"];
const isDir = (path: string) => path === "/code/acme/api";

test("actions come from the PR checkout's cast-tui.json", async () => {
  const read: string[] = [];
  const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const fake: Exec = async (_cmd, args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env ?? {} });
    return { code: 0, stdout: "deployed\n", stderr: "" };
  };
  const actionsFor = configActions({
    exec: fake,
    roots,
    isDir,
    readFile: (path) => {
      read.push(path);
      return CONFIG;
    },
  });
  const [action] = actionsFor(PR);
  assert.ok(action);
  assert.equal(action.key, "d");
  assert.equal(action.label, "deploy staging");
  assert.equal(action.confirm, true);
  assert.deepEqual(await action.run(PR), {
    ok: true,
    text: "deploy staging: deployed",
  });
  assert.deepEqual(calls[0]?.args, ["-c", "task deploy:staging"]);
  assert.equal(calls[0]?.cwd, "/code/acme/api");
  assert.equal(calls[0]?.env.PR_NUMBER, "7");
  assert.equal(calls[0]?.env.PR_BRANCH, "fix-it");
  actionsFor(PR);
  assert.deepEqual(read, ["/code/acme/api/cast-tui.json"]);
});

test("no actions without a checkout, a config, or a valid config", () => {
  const fake: Exec = async () => assert.fail("no command expected");
  const none = (readFile: (path: string) => string | undefined) =>
    configActions({ exec: fake, roots, isDir, readFile });
  assert.deepEqual(none(() => CONFIG)({ ...PR, repo: "other/repo" }), []);
  assert.deepEqual(none(() => undefined)(PR), []);
  assert.deepEqual(none(() => "{oops")(PR), []);
});

test("a failing command reports its exit code and output tail", async () => {
  const fake: Exec = async () => ({ code: 2, stdout: "", stderr: "boom\n" });
  assert.deepEqual(await runCommand(fake, DEPLOY, "/c", PR), {
    ok: false,
    text: "deploy staging failed (exit 2): boom",
  });
});

test("commands run in a shell with the PR environment", async () => {
  const dir = mkdtempSync(`${tmpdir()}/cast-tui-cmd-`);
  const action = { ...DEPLOY, command: 'echo "$PR_REPO#$PR_NUMBER in $PWD"' };
  const o = await runCommand(exec, action, dir, PR);
  assert.deepEqual(o, {
    ok: true,
    text: `deploy staging: acme/api#7 in ${dir}`,
  });
});
