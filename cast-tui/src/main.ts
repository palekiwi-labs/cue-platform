import { homedir } from "node:os";
import {
  getKeybindings,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { listInstances } from "./cast.js";
import { checkoutRoots } from "./checkouts.js";
import { exec } from "./exec.js";
import { isPickerKey, isQuitKey } from "./keys.js";
import { PrBrowser } from "./picker/prs/browser.js";
import { PreviewCache } from "./picker/prs/preview.js";
import { hostDeps, storeRoot } from "./prs.js";
import { Refresher } from "./refresh.js";
import { pickerTheme } from "./theme.js";
import { InstanceListView } from "./view.js";

const REFRESH_INTERVAL_MS = 2000;

export function main(): void {
  const tui = new TuiAltScreen(new ProcessTerminal());
  const home = homedir();
  const view = new InstanceListView({ home });
  const previews = new PreviewCache();
  tui.addChild(view);

  const refresher = new Refresher(async () => {
    try {
      view.setInstances(await listInstances());
    } catch (e) {
      view.setError(e instanceof Error ? e.message : String(e));
    }
    tui.requestRender();
  });

  let picker: OverlayHandle | "opening" | undefined;

  const quit = (): void => {
    refresher.stop();
    tui.stop();
    process.exit(0);
  };

  const openPicker = async (): Promise<void> => {
    picker = "opening";
    const deps = await hostDeps({
      exec,
      cwd: process.cwd(),
      store: storeRoot(process.env, home),
      roots: checkoutRoots(home),
      previews,
    });
    const close = (): void => {
      if (picker !== undefined && picker !== "opening") picker.hide();
      picker = undefined;
      tui.requestRender();
    };
    const keys = getKeybindings();
    const browser = new PrBrowser(tui, pickerTheme, keys, deps, close);
    picker = tui.showOverlay(browser, {
      anchor: "top-left",
      width: "100%",
      maxHeight: "100%",
      margin: 0,
    });
    tui.requestRender();
  };

  tui.addInputListener((data) => {
    if (picker !== undefined) {
      if (matchesKey(data, "ctrl+c")) quit();
      return picker === "opening" ? { consume: true } : undefined;
    }
    if (isQuitKey(data)) {
      quit();
    } else if (isPickerKey(data)) {
      void openPicker();
    } else if (matchesKey(data, "up")) {
      view.moveUp();
      tui.requestRender();
    } else if (matchesKey(data, "down")) {
      view.moveDown();
      tui.requestRender();
    } else if (matchesKey(data, "r")) {
      void refresher.run();
    }
    return undefined;
  });
  tui.start();
  void refresher.run();
  refresher.start(REFRESH_INTERVAL_MS);
}
