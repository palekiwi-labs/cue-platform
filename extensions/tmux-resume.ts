/**
 * tmux-resume: cue-native session picker (tree by cue context).
 *
 * Shortcut: ctrl+r — sessions grouped under their cue context slug,
 * groups ordered by most recent member. Per-session description comes
 * from the newest `session-description` custom entry (see /describe),
 * falling back to session name / first message.
 *
 *   enter   resume in this pi instance (ctx.switchSession)
 *   ctrl+t  open in a new tmux window (fresh pi --session <path>)
 *   ctrl+n  new session in this instance, same cue context injected
 *   ctrl+d  delete session (trash, else unlink) after y/enter confirm
 *   ctrl+l  toggle labeled-only view (native shift+l tree labels)
 *   esc     cancel
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
	Input,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	SessionManager,
	calculateContextTokens,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_VISIBLE = 14;
/** Sessions shown per expanded group before a "+N more" overflow row. */
const MAX_GROUP_SESSIONS = 5;
const CUE_CONTEXT_TYPE = "cue-context";
const DESCRIPTION_TYPE = "session-description";

interface SessionRow {
	path: string;
	cwd: string;
	description: string;
	address?: string;
	slug: string;
	/** Right column, plain text: "<ctx> <age>" */
	right: string;
	/** Fuzzy haystack */
	hay: string;
	modified: number;
	/** Newest active (non-cleared) native label entry, if any. */
	mark?: { text: string; targetId: string };
}

/** Flat row in the rendered tree: a group header or a session. */
interface FlatRow {
	kind: "group" | "session" | "more";
	slug: string;
	/** Group key (context address or "(no context)"). */
	key: string;
	session?: SessionRow;
	/** Sessions of the group, newest first (headers only). */
	sessions?: SessionRow[];
}

/** Absolute context size from the last valid assistant usage in the file. */
function lastContextTokens(path: string): number | null {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.includes('"assistant"')) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = entry?.message;
		if (msg?.role !== "assistant" || !msg.usage) continue;
		if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
		const tokens = calculateContextTokens(msg.usage);
		if (tokens > 0) return tokens;
	}
	return null;
}

interface ParsedSession {
	address?: string;
	description?: string;
	/** Newest active (non-cleared) label on the mainline. */
	mark?: { text: string; targetId: string };
}

/**
 * Mainline branch of a session file: entries from the root to the tip
 * (last entry in file order), following parentId links.
 */
function mainlineBranch(lines: string[]): any[] {
	const byId = new Map<string, any>();
	let tip: any;
	for (const line of lines) {
		if (!line) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry?.id) continue;
		byId.set(entry.id, entry);
		tip = entry;
	}
	const branch: any[] = [];
	let cur = tip;
	while (cur) {
		branch.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return branch;
}

/**
 * Resolve the cue context address (newest cue-context entry on the
 * branch — associations can change over a session's life) and the
 * description (newest session-description entry) from a session file.
 */
function parseSession(path: string): ParsedSession {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	const branch = mainlineBranch(content.split("\n"));
	let address: string | undefined;
	let description: string | undefined;
	let mark: { text: string; targetId: string } | undefined;
	// branch is tip-first, so iterate forward to see newest entries first.
	const labeledTargets = new Set<string>();
	for (const e of branch) {
		if (address === undefined && e?.customType === CUE_CONTEXT_TYPE) {
			const payload =
				e.type === "custom_message"
					? e.details
					: e.type === "custom"
						? e.data
						: undefined;
			const a = payload?.address;
			if (typeof a === "string" && a !== "") address = a;
		}
		if (
			description === undefined &&
			e?.customType === DESCRIPTION_TYPE &&
			typeof e.data?.text === "string" &&
			e.data.text !== ""
		) {
			description = e.data.text;
		}
		// Native label entries: for each targetId the newest entry wins;
		// a re-label without `label` clears it.
		if (e?.type === "label" && !labeledTargets.has(e.targetId)) {
			labeledTargets.add(e.targetId);
			if (mark === undefined && typeof e.label === "string" && e.label !== "") {
				mark = { text: e.label, targetId: e.targetId };
			}
		}
		if (address !== undefined && description !== undefined && mark !== undefined) break;
	}
	return { address, description, mark };
}

function fmtTokens(tokens: number | null): string {
	if (tokens === null) return "-";
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${tokens}`;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

function relTime(date: Date): string {
	const secs = Math.floor((Date.now() - date.getTime()) / 1000);
	if (secs < 60) return "now";
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return date.toISOString().slice(0, 10);
}

const slugOf = (address: string): string => {
	const parts = address.split("/").filter((p) => p !== "");
	return parts[parts.length - 1] ?? address;
};

function buildTree(rows: SessionRow[]): FlatRow[] {
	const groups = new Map<string, SessionRow[]>();
	for (const r of rows) {
		const key = r.address ?? "(no context)";
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}
	const flat: FlatRow[] = [];
	// Groups ordered by most recently modified member session.
	[...groups.entries()]
		.map(([key, sessions]) => ({
			key,
			slug: sessions[0]!.slug,
			sessions: sessions.sort((a, b) => b.modified - a.modified),
			newest: Math.max(...sessions.map((s) => s.modified)),
		}))
		.sort((a, b) => b.newest - a.newest)
		.forEach((g) => {
			flat.push({ kind: "group", slug: g.slug, key: g.key, sessions: g.sessions });
			for (const s of g.sessions) {
				flat.push({ kind: "session", slug: g.slug, key: g.key, session: s });
			}
		});
	return flat;
}

/** Mirror of the built-in picker's deleteSessionFile (not exported):
 * prefer the trash CLI, fall back to unlink. */
async function deleteSessionFile(path: string): Promise<string> {
	try {
		const res = spawnSync("trash", [path], { encoding: "utf-8" });
		if (res.status === 0 || !existsSync(path)) return "moved to trash";
	} catch {
		/* no trash CLI */
	}
	await unlink(path);
	return "deleted";
}

class ResumePicker implements Component {
	private flat: FlatRow[];
	private filtered: FlatRow[];
	private selectedIndex = 0;
	private scrollTop = 0;
	private query = new Input();
	private theme: ThemeLike;
	/** Collapsed group keys. */
	private collapsed = new Set<string>();
	/** Tab-cycled filter mode: match sessions or context headings only. */
	private filterMode: "sessions" | "contexts" = "sessions";
	/** ctrl+l: flat view of sessions with an active native label. */
	private labeledOnly = false;
	/** Session pending delete confirmation. */
	private confirming: SessionRow | null = null;
	private status: { text: string; error: boolean } | null = null;
	/** Path of the active session; never deletable. */
	currentPath?: string;

	onAction?: (row: SessionRow, action: "switch" | "tmux" | "new") => void;
	onCancel?: () => void;
	onRender?: () => void;

	constructor(rows: SessionRow[], theme: ThemeLike) {
		this.flat = buildTree(rows);
		// Start fully collapsed; headings show the newest session's
		// tokens + age, so recent work stays visible without expansion.
		for (const r of this.flat) {
			if (r.kind === "group") this.collapsed.add(r.key);
		}
		this.filtered = this.visible();
		this.theme = theme;
	}

	/** Expanded view of the tree: collapsed groups hide their
	 * children; expanded groups cap at MAX_GROUP_SESSIONS with a
	 * non-selectable "+N more" overflow row. */
	private visible(): FlatRow[] {
		const out: FlatRow[] = [];
		for (const r of this.flat) {
			if (r.kind !== "group") continue;
			out.push(r);
			if (this.collapsed.has(r.key)) continue;
			const sessions = r.sessions!;
			const cap = Math.min(sessions.length, MAX_GROUP_SESSIONS);
			for (let i = 0; i < cap; i++) {
				out.push({ kind: "session", slug: r.slug, key: r.key, session: sessions[i] });
			}
			if (sessions.length > cap) {
				out.push({ kind: "more", slug: r.slug, key: r.key });
			}
		}
		return out;
	}

	/** Nothing cached: render() rebuilds every line from state. */
	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];

		lines.push(
			t.fg("accent", t.bold("Resume Session")) +
				t.fg(
					"dim",
					`  ↑↓ · ⇧↑↓ groups · ←→ fold · tab:${this.filterMode}` +
						`${this.labeledOnly ? " · ^l:labeled" : ""} · ⏎=here · ^t=tmux · ^n=new · ^d=del`,
				),
		);

		if (this.confirming) {
			const d = this.confirming.description || this.confirming.path;
			lines.push(t.fg("error", truncateToWidth(
				`Delete session "${d}"? y/enter confirm · n/esc cancel`, width, "…")));
		} else if (this.status) {
			lines.push(t.fg(this.status.error ? "error" : "dim",
				truncateToWidth(this.status.text, width, "…")));
		}
		lines.push(...this.query.render(width));
		lines.push("");

		if (this.filtered.length === 0) {
			lines.push(t.fg("dim", "  no matching sessions"));
			return lines;
		}

		const start = Math.min(this.scrollTop, Math.max(0, this.filtered.length - MAX_VISIBLE));
		const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
		this.scrollTop = start;

		const rightWidth = 9; // "999.9k 30d"
		for (let i = start; i < end; i++) {
			const row = this.filtered[i];
			if (!row) continue;
			const selected = i === this.selectedIndex;
			const cursor = selected ? "› " : "  ";

			if (row.kind === "group") {
				const collapsed = this.collapsed.has(row.key);
				const marker = collapsed ? "+" : "-";
				const label = `${row.slug} (${row.sessions!.length})`;
				const right = row.sessions![0]!.right;
				const marks = [...new Set(
					row.sessions!
						.filter((s) => s.mark)
						.map((s) => `[${truncateToWidth(s.mark!.text, 12, "…")}]`),
				)];
				const marksPlain = marks.join(" ");
				const marksStyled = marks.length
					? " " + t.fg("error", marksPlain)
					: "";
				const gap = Math.max(1, width - 6 - label.length - marksPlain.length - right.length);
				let line =
					cursor +
					t.fg("dim", `${marker} `) +
					(selected
						? t.fg("warning", t.bold(label))
						: t.fg("warning", label)) +
					marksStyled +
					" ".repeat(gap) +
					t.fg("dim", right);
				if (selected) line = t.bg("selectedBg", line);
				lines.push(" " + truncateToWidth(line, width));
				continue;
			}

			if (row.kind === "more") {
				const total = this.flat.filter(
					(f) => f.kind === "session" && f.key === row.key,
				).length;
				const hidden = total - MAX_GROUP_SESSIONS;
				lines.push(
					t.fg(
						"dim",
						truncateToWidth(`    … +${hidden} more in ${row.slug}`, width),
					),
				);
				continue;
			}

			const s = row.session!;
			const mark = s.mark
				? t.fg("error", `[${truncateToWidth(s.mark.text, 12, "…")}] `)
				: "";
			const markLen = s.mark ? s.mark.text.length + 4 : 0; // "[xx] "
			const title = truncateToWidth(
				s.description,
				Math.max(10, width - 5 - rightWidth - markLen),
				"…",
			);
			const gap = Math.max(1, width - 5 - title.length - s.right.length - markLen);
			let line =
				cursor +
				mark +
				(selected ? t.fg("accent", t.bold(title)) : title) +
				" ".repeat(gap) +
				t.fg("dim", s.right);
			if (selected) line = t.bg("selectedBg", line);
			lines.push("  " + truncateToWidth(line, width));
		}

		const total = this.filtered.filter((r) => r.kind === "session").length;
		if (total > MAX_VISIBLE || start > 0) {
			const selSessionIdx =
				this.filtered.slice(0, this.selectedIndex + 1)
					.filter((r) => r.kind === "session").length;
			lines.push(
				t.fg("dim", truncateToWidth(` ${selSessionIdx}/${total}`, width, "")),
			);
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.confirming) {
			if (matchesKey(data, "return") || data === "y" || data === "Y") {
				const row = this.confirming;
				this.confirming = null;
				void this.delete(row);
			} else if (matchesKey(data, "escape") || data === "n" || data === "N") {
				this.confirming = null;
			}
			this.onRender?.();
			return;
		}
		this.status = null;
		if (matchesKey(data, "ctrl+d")) {
			this.startDelete();
		} else if (matchesKey(data, "up")) {
			this.move(-1);
		} else if (matchesKey(data, "down")) {
			this.move(1);
		} else if (matchesKey(data, "shift+up")) {
			this.jumpGroup(-1);
		} else if (matchesKey(data, "shift+down")) {
			this.jumpGroup(1);
		} else if (matchesKey(data, "left") && this.query.getValue() === "") {
			this.setCollapsed(this.currentKey(), true);
		} else if (matchesKey(data, "right") && this.query.getValue() === "") {
			this.setCollapsed(this.currentKey(), false);
		} else if (matchesKey(data, "tab")) {
			this.filterMode =
				this.filterMode === "sessions" ? "contexts" : "sessions";
			this.refilter();
		} else if (matchesKey(data, "ctrl+l")) {
			this.labeledOnly = !this.labeledOnly;
			this.refilter();
		} else if (matchesKey(data, "return")) {
			this.act("switch");
		} else if (matchesKey(data, "ctrl+t")) {
			this.act("tmux");
		} else if (matchesKey(data, "ctrl+n")) {
			this.act("new");
		} else if (matchesKey(data, "escape")) {
			this.onCancel?.();
		} else {
			this.query.handleInput(data);
			this.refilter();
		}
		this.onRender?.();
	}

	/** Select the current session's row if visible, else its
	 * group heading (group may stay collapsed). */
	focusCurrent(path?: string): void {
		if (!path) return;
		let idx = this.filtered.findIndex((r) => r.session?.path === path);
		if (idx < 0) {
			const grp = this.flat.find(
				(r) => r.kind === "group" && r.sessions!.some((s) => s.path === path),
			);
			if (!grp) return;
			idx = this.filtered.findIndex(
				(r) => r.kind === "group" && r.key === grp.key,
			);
			if (idx < 0) return;
		}
		this.selectedIndex = idx;
		this.clampScroll();
	}

	/** Key of the group under (or owning) the selection. */
	private currentKey(): string {
		const row = this.filtered[this.selectedIndex];
		return row ? row.key : "";
	}

	private setCollapsed(key: string, collapsed: boolean): void {
		if (!key) return;
		if (collapsed) this.collapsed.add(key);
		else this.collapsed.delete(key);
		this.filtered = this.visible();
		this.refilterSelection();
		this.clampScroll();
	}

	private move(delta: number): void {
		let next = Math.min(
			Math.max(0, this.selectedIndex + delta),
			this.filtered.length - 1,
		);
		// Step over "+ more" overflow rows; stay put at the edges.
		while (this.filtered[next]?.kind === "more") {
			const step = next + Math.sign(delta);
			if (step < 0 || step >= this.filtered.length) {
				next = this.selectedIndex;
				break;
			}
			next = step;
		}
		this.selectedIndex = next;
		this.clampScroll();
	}

	/** Jump to the previous/next group heading. */
	private jumpGroup(delta: number): void {
		const from = this.selectedIndex + Math.sign(delta);
		for (let i = from; i >= 0 && i < this.filtered.length; i += Math.sign(delta)) {
			if (this.filtered[i]?.kind === "group") {
				this.selectedIndex = i;
				this.clampScroll();
				return;
			}
		}
	}

	private startDelete(): void {
		const row = this.filtered[this.selectedIndex];
		if (!row) return;
		if (row.kind !== "session" || !row.session) {
			this.status = { text: "Select a session row to delete", error: true };
			return;
		}
		if (row.session.path === this.currentPath) {
			this.status = { text: "Cannot delete the currently active session", error: true };
			return;
		}
		this.confirming = row.session;
	}

	private async delete(row: SessionRow): Promise<void> {
		try {
			const how = await deleteSessionFile(row.path);
			this.flat = this.flat.filter((r) => r.session?.path !== row.path);
			for (const r of this.flat) {
				if (r.kind === "group") {
					r.sessions = r.sessions!.filter((s) => s.path !== row.path);
				}
			}
			this.flat = this.flat.filter(
				(r) => r.kind !== "group" || r.sessions!.length > 0,
			);
			const keep = this.selectedIndex;
			this.refilter();
			this.selectedIndex = keep;
			this.refilterSelection();
			this.clampScroll();
			this.status = { text: `Session ${how}`, error: false };
		} catch (e) {
			this.status = { text: `Delete failed: ${(e as Error).message}`, error: true };
		}
		this.onRender?.();
	}

	private act(action: "switch" | "tmux" | "new"): void {
		const row = this.filtered[this.selectedIndex];
		if (!row) return;
		// Actions on a heading target the group's newest session.
		const target =
			row.kind === "session" ? row.session : row.sessions?.[0];
		if (target) this.onAction?.(target, action);
	}

	private refilter(): void {
		const q = this.query.getValue();
		if (this.labeledOnly) {
			// Flat view of labeled sessions; query narrows within it.
			const pool = this.flat
				.filter((r) => r.kind === "session")
				.map((r) => r.session!)
				.filter((s) => s.mark !== undefined);
			const matching =
				q === ""
					? new Set(pool.map((s) => s.path))
					: new Set(
							fuzzyFilter(pool, q, (s) => s.hay).map((s) => s.path),
					);
			this.filtered = this.flat.filter(
					(r) => r.kind === "session" && matching.has(r.session!.path),
			);
		} else if (q === "") {
			this.filtered = this.visible();
		} else if (this.filterMode === "contexts") {
			const matched = new Set(
				fuzzyFilter(
					this.flat.filter((r) => r.kind === "group"),
					q,
					(r) => r.slug,
				).map((r) => r.key),
			);
			// Heading match shows the matching groups fully expanded
			// (left/right cannot fold while a query is active, since
			// those keys move the caret in the input): heading plus
			// capped sessions plus overflow row. Clearing the query
			// restores the tree with fold state intact.
			this.filtered = [];
			for (const r of this.flat) {
				if (r.kind !== "group" || !matched.has(r.key)) continue;
				this.filtered.push(r);
				const sessions = r.sessions!;
				const cap = Math.min(sessions.length, MAX_GROUP_SESSIONS);
				for (let i = 0; i < cap; i++) {
					this.filtered.push({ kind: "session", slug: r.slug, key: r.key, session: sessions[i] });
				}
				if (sessions.length > cap) {
					this.filtered.push({ kind: "more", slug: r.slug, key: r.key });
				}
			}
		} else {
			const matching = new Set(
				fuzzyFilter(
					this.flat.filter((r) => r.kind === "session").map((r) => r.session!),
					q,
					(s) => s.hay,
				).map((s) => s.path),
			);
			// Match against all sessions, folded or not; results render
			// flat (no headings) so fold state cannot hide matches.
			this.filtered = this.flat.filter(
				(r) => r.kind === "session" && matching.has(r.session!.path),
			);
		}
		this.selectedIndex = 0;
		this.scrollTop = 0;
	}

	private refilterSelection(): void {
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filtered.length - 1),
		);
	}

	private clampScroll(): void {
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + MAX_VISIBLE) {
			this.scrollTop = this.selectedIndex - MAX_VISIBLE + 1;
		}
	}
}

function toRows(sessions: Awaited<ReturnType<typeof SessionManager.list>>): SessionRow[] {
	return sessions.map((s) => {
		const parsed = parseSession(s.path);
		const fallback = (s.name?.trim() || s.firstMessage || "(empty)")
			.replace(/\s+/g, " ")
			.slice(0, 80);
		const description = parsed.description?.trim() || fallback;
		const slug = parsed.address ? slugOf(parsed.address) : "(no context)";
		return {
			path: s.path,
			cwd: s.cwd,
			description,
			address: parsed.address,
			slug,
			right: `${fmtTokens(lastContextTokens(s.path))} ${relTime(new Date(s.modified))}`,
			hay: `${slug} ${description}${parsed.mark ? ` ${parsed.mark.text}` : ""}`,
			modified: new Date(s.modified).getTime(),
			mark: parsed.mark,
		};
	});
}

export default function (pi: ExtensionAPI) {
	const handler = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("session picker requires interactive mode", "warning");
			return;
		}

		const rows = toRows(await SessionManager.list(ctx.cwd));
		if (rows.length === 0) {
			ctx.ui.notify("No sessions found", "info");
			return;
		}

		const result = await ctx.ui.custom<{ row: SessionRow; action: "switch" | "tmux" | "new" } | null>(
			(_tui, theme, _kb, done) => {
				const picker = new ResumePicker(rows, theme as unknown as ThemeLike);
				picker.currentPath = ctx.sessionManager.getSessionFile?.();
				picker.focusCurrent(picker.currentPath);
				picker.onAction = (row, action) => done({ row, action });
				picker.onCancel = () => done(null);
				picker.onRender = () => _tui.requestRender();
				return picker;
			},
		);

		if (!result) return;
		const { row, action } = result;

		if (action === "switch") {
			// Only command contexts can switch the session in this
			// instance; shortcut contexts dispatch the hidden command.
			const switchSession = (ctx as any).switchSession as
				| ((p: string, o?: unknown) => Promise<unknown>)
				| undefined;
			if (switchSession) {
				await switchSession(row.path);
			} else {
				pi.sendUserMessage(`/resume-open ${row.path}`, {
					expandPromptTemplates: true,
				});
			}
			return;
		}

		if (action === "tmux") {
			if (!process.env.TMUX) {
				ctx.ui.notify("Not running inside tmux", "warning");
				return;
			}
			spawnTmux(row);
			return;
		}

		// action === "new": fresh session in this instance, same context.
		if (!row.address) {
			ctx.ui.notify("session has no cue context", "warning");
			return;
		}
		const newSession = (ctx as any).newSession as
			| ((o?: { withSession?: (nctx: any) => Promise<void> }) => Promise<unknown>)
			| undefined;
		if (newSession) {
			const address = row.address;
			await newSession({
				// Full orientation + naming via the /cue:context:inject command.
				withSession: async (nctx: any) => {
					await nctx.sendUserMessage(`/cue:context:inject ${address}`, {
						expandPromptTemplates: true,
					});
				},
			});
		} else {
			pi.sendUserMessage(`/resume-open new ${row.address}`, {
				expandPromptTemplates: true,
			});
		}
	};

	const spawnTmux = (row: SessionRow, injectContext = false) => {
		const cwd = row.cwd || process.cwd();
		const args = injectContext && row.address
			? ["new-window", "-c", cwd, "pi", `/cue:context:inject ${row.address}`]
			: ["new-window", "-c", cwd, "pi", "--session", row.path];
		spawn("tmux", args, { detached: true, stdio: "ignore" });
	};

	pi.registerShortcut("ctrl+r", {
		description: "Cue-native session picker: tree by context",
		handler,
	});
	pi.registerCommand("tmux-resume", {
		description: "Cue-native session picker: tree by context",
		handler: async (_args, ctx) => handler(ctx),
	});

	// Hidden dispatcher: shortcut contexts cannot switch sessions, so
	// they route through this command, whose context can.
	pi.registerCommand("resume-open", {
		description: "Internal: switch/new session for the resume picker",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "new") {
				const address = parts.slice(1).join("");
				if (!address) return;
				await (ctx as any).newSession({
					// Full orientation + naming via the /cue:context:inject command.
					withSession: async (nctx: any) => {
						await nctx.sendUserMessage(`/cue:context:inject ${address}`, {
							expandPromptTemplates: true,
						});
					},
				});
				return;
			}
			const path = args.trim();
			if (path) await (ctx as any).switchSession(path);
		},
	});
}
