// Custom footer. Ported from pi v1.1.0's built-in FooterComponent
// (modes/interactive/components/footer.ts) with two changes:
// - context shown as absolute tokens (same figure as cue-context-usage),
//   coloured by the cue context-usage thresholds;
// - up-arrow shows total input (input + cacheRead + cacheWrite).
// The plan-usage status is right-aligned on its own line; other statuses
// render left-aligned as in pi.
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Mirrors src/pi/lib/context-usage.ts DEFAULT_THRESHOLDS.
const THRESHOLDS = { caution: 80_000, soft: 100_000, hard: 140_000 };
const RIGHT_STATUS_KEY = "plan-usage";

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside =
    rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function addUsage(t: Totals, u: any): void {
  if (!u) return;
  t.input += u.input ?? 0;
  t.output += u.output ?? 0;
  t.cacheRead += u.cacheRead ?? 0;
  t.cacheWrite += u.cacheWrite ?? 0;
  t.cost += u.cost?.total ?? 0;
}

function sessionTotals(ctx: ExtensionContext) {
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHit: number | undefined;
  for (const entry of ctx.sessionManager.getEntries() as any[]) {
    if (entry.type === "usage") {
      addUsage(totals, entry.usage);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const u = entry.message.usage;
      addUsage(totals, u);
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      cacheHit = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      addUsage(totals, entry.message.usage);
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      addUsage(totals, entry.usage);
    }
  }
  return { totals, cacheHit };
}

// Compact rendering for known status keys; others are dimmed like the
// rest of the footer. The publisher's text stays verbose so pi's
// built-in footer remains readable without this extension.
function styleStatus(_key: string, text: string, theme: any): string {
  return theme.fg("dim", text);
}

// mcp-cast is environment state, shown at the start of line 1 and
// only while unhealthy (connecting/unreachable). Healthy: hidden.
const MCP_KEY = "mcp-cast";
function mcpMarker(text: string | undefined, theme: any): string {
  if (!text) return "";
  const state = sanitizeStatusText(text).replace(/^mcp-cast:\s*/, "");
  if (state.startsWith("unreachable")) return theme.fg("error", "●");
  if (state.startsWith("connecting")) return theme.fg("warning", "●");
  return "";
}

// Left text, right text right-aligned; right is truncated first.
function joinLR(left: string, right: string, width: number): string {
  let l = truncateToWidth(left, width, "...");
  const lw = visibleWidth(l);
  if (!right) return l;
  const avail = width - lw - 2;
  if (avail <= 0) return l;
  const r = truncateToWidth(right, avail, "");
  return l + " ".repeat(Math.max(0, width - lw - visibleWidth(r))) + r;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const { totals } = sessionTotals(ctx);
          const usage = ctx.getContextUsage();
          const model = ctx.model;
          const dim = (s: string) => theme.fg("dim", s);

          // Line 1: cwd (branch) • session    ...    (provider) model • level
          let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME);
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const name = ctx.sessionManager.getSessionName();
          const nameSuffix = name ? ` • ${name}` : "";

          const modelName = model?.id || "no-model";
          let modelText = modelName;
          if ((model as any)?.reasoning) {
            const lvl = pi.getThinkingLevel() || "off";
            modelText = lvl === "off" ? `${modelName} • thinking off` : `${modelName} • ${lvl}`;
          }
          const withProvider =
            footerData.getAvailableProviderCount() > 1 && model
              ? `(${model.provider}) ${modelText}`
              : modelText;
          const statuses = footerData.getExtensionStatuses();
          const mcp = mcpMarker(statuses.get(MCP_KEY), theme);
          const left1 = dim(pwd + nameSuffix);
          // Marker sits in front of the (provider) model part.
          const pre = mcp ? `${mcp} ` : "";
          const right1 = pre + dim(withProvider);
          const line1 =
            visibleWidth(left1) + 2 + visibleWidth(right1) <= width
              ? joinLR(left1, right1, width)
              : joinLR(left1, pre + dim(modelText), width);

          // Line 2: tokens cost context statuses    ...    plan-usage
          const totalIn = totals.input + totals.cacheRead + totals.cacheWrite;
          const tokenParts: string[] = [];
          if (totalIn) tokenParts.push(`↑${formatTokens(totalIn)}`);
          if (totals.output) tokenParts.push(`↓${formatTokens(totals.output)}`);
          const sub = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
          const cost =
            totals.cost || sub ? `$${totals.cost.toFixed(3)}${sub ? " (sub)" : ""}` : "";

          const tokens = usage?.tokens;
          let ctxStr: string;
          if (tokens == null) {
            ctxStr = dim("?");
          } else {
            const color =
              tokens >= THRESHOLDS.soft
                ? "error"
                : tokens >= THRESHOLDS.caution
                  ? "warning"
                  : "success";
            ctxStr = theme.fg(color, formatTokens(tokens));
            if (tokens >= THRESHOLDS.hard) ctxStr = theme.bold(ctxStr);
          }

          const others = Array.from(statuses.entries())
            .filter(([k]) => k !== RIGHT_STATUS_KEY && k !== MCP_KEY)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, t]) => styleStatus(k, sanitizeStatusText(t), theme));
          const right = statuses.get(RIGHT_STATUS_KEY) ?? "";

          const build = (withCost: boolean) =>
            [
              tokenParts.length ? dim(tokenParts.join(" ")) : "",
              withCost && cost ? dim(cost) : "",
              ctxStr,
              ...others,
            ]
              .filter(Boolean)
              .join(" ");
          // Drop cost first when narrow; it says little on a subscription.
          let left = build(true);
          if (right && visibleWidth(left) + 2 + visibleWidth(right) > width) {
            left = build(false);
          }
          return [line1, joinLR(left, right, width)];
        },
      };
    });
  });
}
