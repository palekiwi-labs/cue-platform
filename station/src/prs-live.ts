import type { ChangedEvent, RefreshOutcome } from "../../github-service/src/protocol.js";
import type { PrsData, PrsSource } from "./prs-source.js";
import type { PrsView } from "./prs.js";
import { type Revision, Reloader } from "./reload.js";

export interface PrsFeed {
  repo: string;
  read: () => Promise<PrsData>;
  refresh: () => Promise<RefreshOutcome | undefined>;
  onChanged: (listener: (event: ChangedEvent) => void) => () => void;
  onReconnect: (listener: () => void) => () => void;
}

export function sourceFeed(source: PrsSource): PrsFeed {
  return {
    repo: source.repo,
    read: () => source.read(),
    refresh: () => source.refresh(),
    onChanged: (listener) => source.client.onChanged(listener),
    onReconnect: (listener) => source.client.onReconnect(listener),
  };
}

const FLASH_MS = 4000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Keeps a PR list in step with the GitHub service: change events for the
 * repository and reconnects reload the stored list, R asks the service to
 * fetch from GitHub first. All reads go through one reloader, so a refresh
 * whose change event was already applied does not read again.
 */
export class LivePrs {
  private readonly reloader: Reloader<PrsData>;
  private readonly off: (() => void)[];
  private refreshing = false;
  private note = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly view: PrsView,
    private readonly feed: PrsFeed,
    private readonly render: () => void,
  ) {
    this.reloader = new Reloader<PrsData>({
      read: () => feed.read(),
      revision: (data) => ({ storeId: data.storeId, revision: data.revision }),
      apply: (data, changed, previous) => this.apply(data, changed, previous !== null),
      fail: (e) => {
        this.note = `GitHub service: ${errText(e)}`;
        if (!this.refreshing) this.view.setNote(this.note);
        this.render();
      },
    });
    this.off = [
      feed.onChanged((event) => {
        if (event.repo === feed.repo) void this.reloader.notify(event);
      }),
      feed.onReconnect(() => void this.reloader.reconcile()),
    ];
  }

  async start(): Promise<void> {
    this.view.setNote("loading snapshot…");
    this.render();
    await this.reloader.reload();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.view.setNote("refreshing through GitHub service…");
    this.render();
    let failure: string | null = null;
    let target: Revision | null = null;
    try {
      const outcome = await this.feed.refresh();
      const shown = this.reloader.shown;
      if (outcome?.state === "success" && outcome.changed === true && outcome.revision !== undefined && shown !== null) {
        target = { storeId: shown.storeId, revision: outcome.revision };
      }
    } catch (e) {
      failure = `GitHub service: ${errText(e)}`;
    }
    if (failure === null) await (target === null ? this.reloader.reload() : this.reloader.notify(target));
    this.refreshing = false;
    this.view.setNote(failure ?? this.note);
    this.render();
  }

  dispose(): void {
    for (const off of this.off) off();
    this.reloader.close();
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private apply(data: PrsData, changed: boolean, updating: boolean): void {
    this.note = data.note;
    if (!this.refreshing) this.view.setNote(data.note);
    if (changed) {
      const gone = this.view.setPrs(data.prs, data.viewer);
      if (updating) this.flash(gone === undefined ? "PR list updated" : `PR #${gone.number} closed or merged`);
    }
    this.render();
  }

  private flash(text: string): void {
    this.view.flash(text, FLASH_MS);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), FLASH_MS + 50);
    this.timer.unref?.();
  }
}
