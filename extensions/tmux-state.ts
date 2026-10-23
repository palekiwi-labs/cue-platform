/**
 * tmux-state: publish the pi session state on its tmux window.
 *
 * Sets window user options that the tmux statusline colours tabs from:
 *
 *   @pi_state   working | blocked | idle
 *   @pi_unseen  1 when the agent settled while the window was not active;
 *               cleared by a tmux session-window-changed hook.
 *   @pi_ctx     context tokens, absolute (after each turn; same figure
 *               as the footer)
 *   @pi_prompt  last user prompt, first line, truncated
 *
 * blocked covers turns that ended in an error, and anything another
 * extension flags via pi.events.emit("tmux-state:blocked", { active }).
 * Modelled on herdr's pi integration (herdr-agent-state.ts) with tmux
 * options in place of herdr's socket. No-op outside tmux.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type State = "working" | "blocked" | "idle";

const IDLE_DEBOUNCE_MS = 250;
const PROMPT_MAX = 200;

const oneLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
};

/** Text of the last user message on the session branch, if any. */
const lastUserPrompt = (branch: readonly any[]): string | undefined => {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const m = branch[i]?.type === "message" ? branch[i].message : undefined;
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    const t = Array.isArray(c) ? c.find((p: any) => p?.type === "text") : undefined;
    if (t?.text) return t.text;
  }
  return undefined;
};

export default function (pi: ExtensionAPI) {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return;
  // Child pi processes (cue-agent/delegate subagents, pi -p) inherit
  // TMUX_PANE; only the interactive pi owning the pane's tty may touch
  // the window's state options.
  if (!process.stdout.isTTY) return;

  let active = false;
  let failed = false;
  let blockedCount = 0;
  let last: State | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const tmux = (args: string[]) => {
    queue = queue.then(
      () => pi.exec("tmux", args).catch(() => undefined),
    );
    return queue;
  };

  const setOpt = (key: string, value: string) =>
    tmux(["set-option", "-w", "-t", pane, key, value]);

  const windowActive = async () => {
    try {
      const r = await pi.exec("tmux", [
        "display-message", "-p", "-t", pane, "#{window_active}",
      ]);
      return r.stdout.trim() === "1";
    } catch {
      return true;
    }
  };

  const desired = (): State =>
    blockedCount > 0 || failed ? "blocked" : active ? "working" : "idle";

  const publish = async (force = false) => {
    const next = desired();
    if (!force && next === last) return;
    last = next;
    await setOpt("@pi_state", next);
    if (next === "working") {
      await setOpt("@pi_unseen", "");
    } else if (!(await windowActive())) {
      await setOpt("@pi_unseen", "1");
    }
  };

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  pi.events.on("tmux-state:blocked", (data: any) => {
    blockedCount = data?.active
      ? blockedCount + 1
      : Math.max(0, blockedCount - 1);
    clearIdle();
    void publish();
  });

  const publishCtx = (ctx: any) => {
    const tokens = ctx.getContextUsage?.()?.tokens;
    if (typeof tokens === "number") void setOpt("@pi_ctx", String(tokens));
  };

  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI) return;
    active = ctx.isIdle() === false;
    failed = false;
    await publish(true);
    const prompt = lastUserPrompt(ctx.sessionManager.getBranch());
    await setOpt("@pi_prompt", prompt ? oneLine(prompt) : "");
    publishCtx(ctx);
  });

  pi.on("input", (event) => {
    if (event.source === "extension" || !event.text.trim()) return;
    void setOpt("@pi_prompt", oneLine(event.text));
  });

  pi.on("agent_start", async () => {
    clearIdle();
    active = true;
    failed = false;
    await publish();
  });

  pi.on("agent_end", (event: any, ctx) => {
    active = false;
    publishCtx(ctx);
    const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const lastAssistant = [...msgs].reverse().find((m) => m?.role === "assistant");
    failed = lastAssistant?.stopReason === "error";
    clearIdle();
    idleTimer = setTimeout(() => void publish(), IDLE_DEBOUNCE_MS);
    idleTimer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    clearIdle();
    await tmux(["set-option", "-wu", "-t", pane, "@pi_state"]);
    for (const key of ["@pi_unseen", "@pi_ctx", "@pi_prompt"]) {
      await tmux(["set-option", "-wu", "-t", pane, key]);
    }
  });
}
