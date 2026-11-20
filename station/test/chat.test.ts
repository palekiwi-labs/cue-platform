import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_OPTION, chatSessionDir, chatSessionId, findChatWindow, openChat, piCommand } from "../src/chat.js";

const target = { repoSlug: "Spabreaks/Spabreaks", pr: 42, cwd: "/r/worktrees/review/pr-42", context: "spabreaks/spabreaks/review-pr-42" };

test("session id is stable per repo and PR", () => {
  assert.equal(chatSessionId("Spabreaks/Spabreaks", 42), "station-spabreaks-spabreaks-pr-42");
  assert.equal(chatSessionId("a/b.c", 1), "station-a-b.c-pr-1");
});

test("session dir lives under the pi agent dir", () => {
  assert.equal(chatSessionDir({ PI_CODING_AGENT_DIR: "/p" }), "/p/station-sessions");
});

test("pi command pins session dir, id and context", () => {
  assert.equal(piCommand("s", "/d", "a/b/c"), "pi --session-dir '/d' --session-id 's' --cue-inject 'a/b/c'");
});

test("finds the tagged window", () => {
  assert.equal(findChatWindow("@1 \n@2 other\n@3 s-1\n", "s-1"), "@3");
  assert.equal(findChatWindow("@1 \n", "s-1"), null);
});

test("outside tmux it refuses", async () => {
  await assert.rejects(openChat(target, async () => "", {}), /needs tmux/);
});

test("switches to an open chat window", async () => {
  const calls: string[][] = [];
  const result = await openChat(target, async (args) => {
    calls.push(args);
    return args[0] === "list-windows" ? "@1 \n@7 station-spabreaks-spabreaks-pr-42\n" : "";
  }, { TMUX: "x" });
  assert.equal(result, "switched");
  assert.deepEqual(calls.at(-1), ["switch-client", "-t", "@7"]);
});

test("launches and tags a new window when none is open", async () => {
  const calls: string[][] = [];
  const result = await openChat(target, async (args) => {
    calls.push(args);
    return args[0] === "new-window" ? "@9\n" : "";
  }, { TMUX: "x", PI_CODING_AGENT_DIR: "/p" });
  assert.equal(result, "launched");
  const launch = calls[1]!;
  assert.deepEqual(launch.slice(0, 8), ["new-window", "-P", "-F", "#{window_id}", "-n", "pr-42", "-c", target.cwd]);
  assert.match(launch[8]!, /--session-dir '\/p\/station-sessions' --session-id 'station-spabreaks-spabreaks-pr-42' --cue-inject 'spabreaks\/spabreaks\/review-pr-42'$/);
  assert.deepEqual(calls[2], ["set-option", "-w", "-t", "@9", CHAT_OPTION, "station-spabreaks-spabreaks-pr-42"]);
});
