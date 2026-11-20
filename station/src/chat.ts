import { homedir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "./git.js";

export const CHAT_OPTION = "@station-chat";

export function chatSessionId(repoSlug: string, pr: number): string {
  const slug = repoSlug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `station-${slug}-pr-${pr}`;
}

export function chatSessionDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "station-sessions");
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export function piCommand(sessionId: string, sessionDir: string, context: string): string {
  return [
    "pi",
    "--session-dir", shellQuote(sessionDir),
    "--session-id", shellQuote(sessionId),
    "--cue-inject", shellQuote(context),
  ].join(" ");
}

export function chatWindowArgs(name: string, cwd: string, command: string): string[] {
  return ["new-window", "-P", "-F", "#{window_id}", "-n", name, "-c", cwd, `direnv exec ${shellQuote(cwd)} ${command}`];
}

export function findChatWindow(listing: string, sessionId: string): string | null {
  for (const line of listing.split("\n")) {
    const [id, tag] = line.trim().split(" ");
    if (id && tag === sessionId) return id;
  }
  return null;
}

export type Tmux = (args: string[]) => Promise<string>;

const tmux: Tmux = (args) => spawnAsync("tmux", args, process.cwd());

export interface ChatTarget {
  repoSlug: string;
  pr: number;
  cwd: string;
  context: string;
}

/** Switch to the PR's chat window, or open one running pi on its session. */
export async function openChat(target: ChatTarget, run: Tmux = tmux, env: NodeJS.ProcessEnv = process.env): Promise<"switched" | "launched"> {
  if (!env.TMUX) throw new Error("station chat needs tmux");
  const id = chatSessionId(target.repoSlug, target.pr);
  const listing = await run(["list-windows", "-a", "-F", `#{window_id} #{${CHAT_OPTION}}`]);
  const existing = findChatWindow(listing, id);
  if (existing !== null) {
    await run(["switch-client", "-t", existing]);
    return "switched";
  }
  const command = piCommand(id, chatSessionDir(env), target.context);
  const window = (await run(chatWindowArgs(`pr-${target.pr}`, target.cwd, command))).trim();
  await run(["set-option", "-w", "-t", window, CHAT_OPTION, id]);
  return "launched";
}
