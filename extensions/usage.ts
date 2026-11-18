import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Quota = {
	used?: number;
	total?: number;
	remaining?: number;
	remainingPercentage?: number;
	resetAt?: string;
	unlimited?: boolean;
};

type AccountUsage = {
	plan?: string;
	quotas?: Record<string, Quota>;
	resetCredits?: { availableCount?: number } | null;
};

type Connection = {
	id: string;
	provider: string;
	name?: string | null;
	email?: string | null;
	isActive?: boolean;
};

type UsageStats = {
	byProvider?: Record<string, { requests?: number; cost?: number }>;
};

type Snapshot = {
	baseUrl: string;
	accounts: { label: string; plan: string | null; usage: AccountUsage | null; error?: string }[];
	today: string[];
};

const PROVIDER_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
	glm: "GLM",
	gemini: "Gemini",
};

const WINDOW_WIDTH = 56;

function config(): { baseUrl: string; password: string | undefined } {
	return {
		baseUrl: process.env.NINEROUTER_URL ?? "http://127.0.0.1:20128",
		password: process.env.NINEROUTER_PASSWORD,
	};
}

async function login(baseUrl: string, password: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
	if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
	const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
	if (cookies.length === 0) throw new Error("login returned no session cookie");
	return cookies.join("; ");
}

async function api<T>(baseUrl: string, cookie: string, path: string): Promise<T> {
	const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

export async function fetchSnapshot(): Promise<Snapshot> {
	const { baseUrl, password } = config();
	if (!password) {
		throw new Error("NINEROUTER_PASSWORD is not set (9router dashboard password)");
	}
	const cookie = await login(baseUrl, password);
	const [{ connections }, stats] = await Promise.all([
		api<{ connections: Connection[] }>(baseUrl, cookie, "/api/providers"),
		api<UsageStats>(baseUrl, cookie, "/api/usage/stats"),
	]);
	const active = connections.filter((c) => c.isActive !== false);
	const accounts = await Promise.all(
		active.map(async (c) => {
			const label = `${PROVIDER_LABELS[c.provider] ?? c.provider} · ${c.name ?? c.email ?? c.id}`;
			try {
				const usage = await api<AccountUsage>(baseUrl, cookie, `/api/usage/${c.id}`);
				return { label, plan: usage.plan ?? null, usage, error: undefined };
			} catch (err) {
				return { label, plan: null, usage: null, error: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
	const today = Object.entries(stats.byProvider ?? {}).map(([provider, s]) => {
		const cost = s.cost ? `$${s.cost.toFixed(2)}` : "$0.00";
		return `${provider} ${cost} · ${s.requests ?? 0} req`;
	});
	return { baseUrl, accounts, today };
}

function fmtDuration(ms: number): string {
	if (ms <= 0) return "now";
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

function fmtReset(resetAt: string | undefined, now: Date): string {
	if (!resetAt) return "";
	const t = new Date(resetAt);
	if (Number.isNaN(t.getTime())) return "";
	const delta = t.getTime() - now.getTime();
	if (delta < 24 * 3600_000) return `resets in ${fmtDuration(delta)}`;
	return `resets ${t.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

function bar(usedPct: number, theme: Theme): string {
	const width = 12;
	const filled = Math.max(0, Math.min(width, Math.round((usedPct / 100) * width)));
	const color = usedPct >= 80 ? "error" : usedPct >= 50 ? "warning" : "success";
	const glyph = "█".repeat(filled) + "░".repeat(width - filled);
	return theme.fg(color, glyph);
}

export class UsageOverlay {
	private theme: Theme;
	private snapshot: Snapshot;
	private fetchedAt: Date;
	private done: () => void;

	constructor(theme: Theme, snapshot: Snapshot, done: () => void) {
		this.theme = theme;
		this.snapshot = snapshot;
		this.fetchedAt = new Date();
		this.done = done;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "return") ||
			matchesKey(data, "q")
		) {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.min(width, WINDOW_WIDTH) - 2;
		const lines: string[] = [];
		const pad = (s: string) => (s ? ` ${s}` : "");

		for (const account of this.snapshot.accounts) {
			const plan = account.plan ? th.fg("dim", ` (${account.plan})`) : "";
			lines.push(th.fg("accent", pad(account.label)) + plan);
			if (account.error) {
				lines.push(pad(th.fg("error", `error: ${account.error}`)));
				lines.push("");
				continue;
			}
			const quotas = Object.entries(account.usage?.quotas ?? {});
			for (const [name, quota] of quotas) {
				const pct =
					quota.remainingPercentage !== undefined
						? 100 - quota.remainingPercentage
						: quota.total && quota.total > 0
							? (quota.used ?? 0) * 100 / quota.total
							: 0;
				const shown = quota.unlimited
					? th.fg("success", "unlimited")
					: `${bar(pct, th)} ${Math.round(pct)}% used`;
				const reset = th.fg("dim", fmtReset(quota.resetAt, this.fetchedAt));
				lines.push(pad(`  ${name}  ${shown}`));
				lines.push(pad(`  ${reset}`));
			}
			if (quotas.length === 0) {
				lines.push(pad(th.fg("dim", "  no quota data")));
			}
			const credits = account.usage?.resetCredits?.availableCount;
			if (credits !== undefined && credits !== null) {
				lines.push(pad(th.fg("dim", `  reset credits: ${credits} available`)));
			}
			lines.push("");
		}
		if (this.snapshot.today.length > 0) {
			lines.push(pad(th.fg("dim", `today: ${this.snapshot.today.join(" · ")}`)));
			lines.push("");
		}
		lines.push(th.fg("dim", pad("esc/q to close")));
		return this.box(lines, innerW + 2, "9router usage");
	}

	private box(lines: string[], width: number, title: string): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const result: string[] = [];
		const titleStr = truncateToWidth(` ${title} `, innerW);
		const titleW = visibleWidth(titleStr);
		const left = "─".repeat(Math.floor((innerW - titleW) / 2));
		const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
		result.push(
			th.fg("border", `╭${left}`) + th.fg("accent", titleStr) + th.fg("border", `${right}╮`),
		);
		for (const line of lines) {
			result.push(
				th.fg("border", "│") + truncateToWidth(line, innerW, "…", true) + th.fg("border", "│"),
			);
		}
		result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return result;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show 9router subscription usage in an overlay",
		handler: async (_args: string, ctx) => {
			let snapshot: Snapshot;
			try {
				snapshot = await fetchSnapshot();
			} catch (err) {
				ctx.ui.notify(`usage: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => new UsageOverlay(theme, snapshot, done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: WINDOW_WIDTH },
				},
			);
		},
	});
}
