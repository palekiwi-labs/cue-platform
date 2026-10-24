/**
 * session-describe: /describe <text> stores a description with the
 * session (a session-description custom entry, read by the session
 * pickers) and publishes it on the tmux window as @pi_desc.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESCRIPTION_TYPE = "session-description";

/** Publish the description on the tmux window for the C-f picker. */
async function publishDesc(pi: ExtensionAPI, text: string): Promise<void> {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;
	try {
		await pi.exec("tmux", ["set-option", "-wq", "-t", pane, "@pi_desc", text]);
	} catch {
		/* ignore */
	}
}

export default function (pi: ExtensionAPI) {
	// /describe <text>: persist a description with this session and
	// publish it to the tmux window (@pi_desc, shown by the C-f picker).
	pi.registerCommand("describe", {
		description: "Set this session's description (shown in pickers)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("usage: /describe <description>", "warning");
				return;
			}
			pi.appendEntry(DESCRIPTION_TYPE, { text });
			await publishDesc(pi, text);
			ctx.ui.notify(`Description set: ${truncateToWidth(text, 50, "…")}`, "info");
		},
	});

	// Republish the description when a session (re)starts, e.g. resume.
	// ctx (not pi) carries the sessionManager; a stale description from
	// the previous session is cleared so the window never lies.
	pi.on("session_start", async (_event, ctx) => {
		const entries = (ctx as any).sessionManager?.getBranch?.() as
			| any[]
			| undefined;
		let text = "";
		if (entries) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (
					e?.customType === DESCRIPTION_TYPE &&
					typeof e.data?.text === "string"
				) {
					text = e.data.text;
					break;
				}
			}
		}
		await publishDesc(pi, text);
	});
}
