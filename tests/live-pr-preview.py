#!/usr/bin/env python3
"""Exercise PR preview keys through the installed pi without credentials or a model."""

import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main(mode):
    with tempfile.TemporaryDirectory(prefix="cue-pr-preview-") as directory:
        work = Path(directory)
        agent = work / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({
            "theme": "dark", "tuiMode": mode, "defaultProjectTrust": "never",
            "enableInstallTelemetry": False, "enableAnalytics": False,
        }))
        (agent / "keybindings.json").write_text(json.dumps({
            "app.clear": "ctrl+d", "app.exit": "ctrl+q",
        }))
        state = work / "state.json"
        probe = work / "probe.ts"
        probe.write_text('''import { writeFileSync } from "node:fs";
import { PrBrowser } from BROWSER;
import { PreviewCache } from PREVIEW;
export default function(pi) {
  pi.registerCommand("test-preview", { handler: async (_, ctx) => {
    await ctx.ui.custom((tui, theme, kb, done) => {
      const pr = {repo:"o/r",number:1,title:"Fixture PR",url:"",author:"author",
        isDraft:false,createdAt:"2026-01-01",reviewDecision:null,checks:null,
        baseRef:"main",headRef:"topic",defaultBranch:"main",reviewers:[],labels:[]};
      class Probe extends PrBrowser {
        render(width) {
          const lines = super.render(width);
          writeFileSync(STATE, JSON.stringify({scroll:this.previewScroll, width,
            lines, keys: Object.fromEntries(["halfPageUp","halfPageDown","top","bottom"]
              .map(id => [id,kb.getKeys(`tui.altScreen.${id}`)]))}));
          return lines;
        }
      }
      return new Probe(tui, theme, kb, {
        view:"repo",orgs:["o"],localRepo:"o/r",target:"here",previews:new PreviewCache(),
        load:async()=>({prs:[pr],viewer:"author",failed:[],truncated:false}),
        links:async()=>new Map(),
        detail:async()=>({threads:[{kind:"comment",messages:[{id:1,author:"reviewer",
          at:"2026-01-01",body:Array.from({length:100},(_,i)=>`paragraph ${i} long wrapped text`).join("\\n\\n")}]}]}),
      },done);
    },{overlay:true,overlayOptions:{anchor:"top-left",width:"100%",maxHeight:"100%",margin:0}});
  }});
}
'''.replace("BROWSER", json.dumps(str(ROOT / "src/pi/prs/browser.ts")))
            .replace("PREVIEW", json.dumps(str(ROOT / "src/pi/prs/preview.ts")))
            .replace("STATE", json.dumps(str(state))))
        socket = str(work / "tmux.sock")

        def tmux(*args, check=True):
            return subprocess.run(["tmux", "-S", socket, "-f", "/dev/null", *args],
                                  check=check, text=True, capture_output=True).stdout

        def wait_for(predicate):
            deadline = time.monotonic() + 20
            value = None
            while time.monotonic() < deadline:
                try:
                    value = json.loads(state.read_text())
                    if predicate(value):
                        return value
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                time.sleep(0.1)
            raise AssertionError(f"Preview state: {value}; screen: " + tmux("capture-pane", "-p"))

        command = shlex.join([
            "env", f"PI_CODING_AGENT_DIR={agent}", "PI_OFFLINE=1", "pi",
            "--no-session", "--no-mcp", "--no-skills", "--no-context-files",
            "--no-prompt-templates", "--no-approve", "-e", str(probe),
        ])
        try:
            tmux("new-session", "-d", "-s", "preview", "-x", "120", "-y", "30",
                 "-c", directory, command)
            time.sleep(4)
            tmux("send-keys", "-l", "/test-preview")
            tmux("send-keys", "Enter")
            initial = wait_for(lambda s: "paragraph 0" in "\n".join(s["lines"]))
            print("Installed pi bindings:", initial["keys"])
            tmux("send-keys", "C-End")
            bottom = wait_for(lambda s: s["scroll"] > 100)["scroll"]
            tmux("send-keys", "C-Home")
            wait_for(lambda s: s["scroll"] == 0)
            tmux("send-keys", "C-d")
            wait_for(lambda s: s["scroll"] == 7)
            tmux("send-keys", "C-u")
            wait_for(lambda s: s["scroll"] == 0)
            tmux("send-keys", "Escape", "l")
            wait_for(lambda s: any(" │ " in line for line in s["lines"]))
            tmux("send-keys", "C-d")
            wait_for(lambda s: s["scroll"] == 12)
            tmux("send-keys", "C-End")
            wait_for(lambda s: s["scroll"] != bottom and s["scroll"] > 100)
            tmux("resize-window", "-x", "60", "-y", "18")
            wait_for(lambda s: s["width"] == 60 and len(s["lines"]) == 18)
            tmux("send-keys", "C-Home")
            wait_for(lambda s: s["scroll"] == 0)
            print(f"PASS ({mode}): installed pi overlay top/bottom, half-pages, layout and resize")
        finally:
            tmux("kill-server", check=False)


if __name__ == "__main__":
    for tui_mode in ("fullscreen", "regular"):
        main(tui_mode)
