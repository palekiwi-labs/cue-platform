#!/usr/bin/env python3
"""Exercise pi's local-package reload without touching user state or calling a model."""

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="cue-platform-footer-") as directory:
        work = Path(directory)
        package = work / "package"
        package.mkdir()
        shutil.copy(ROOT / "package.json", package)
        shutil.copytree(ROOT / "extensions", package / "extensions")
        footer = package / "extensions/footer.ts"
        source = footer.read_text()
        marker = 'const tokenParts: string[] = [];'
        assert source.count(marker) == 1
        footer.write_text(source.replace(marker, 'const tokenParts: string[] = ["live-footer-before"];'))

        agent = work / "agent"
        agent.mkdir()
        settings = agent / "settings.json"
        settings.write_text(json.dumps({
            "packages": [str(package)],
            "theme": "dark",
            "defaultProjectTrust": "never",
            "enableInstallTelemetry": False,
            "enableAnalytics": False,
        }))
        probe = work / "state-probe.ts"
        probe.write_text('''export default function (pi) {
  pi.registerCommand("test-block", {
    handler: async () => pi.events.emit("tmux-state:blocked", { active: true }),
  });
  pi.registerCommand("test-unblock", {
    handler: async () => pi.events.emit("tmux-state:blocked", { active: false }),
  });
}
''')
        socket = str(work / "tmux.sock")

        def tmux(*args, check=True):
            return subprocess.run(
                ["tmux", "-S", socket, "-f", "/dev/null", *args],
                check=check, text=True, capture_output=True,
            ).stdout

        def wait_for(target, text):
            deadline = time.monotonic() + 30
            screen = ""
            while time.monotonic() < deadline:
                screen = tmux("capture-pane", "-p", "-t", target)
                if text in screen:
                    return screen
                time.sleep(0.2)
            raise AssertionError(f"Missing {text!r}:\n{screen}")

        def wait_state(target, expected):
            deadline = time.monotonic() + 10
            actual = ""
            while time.monotonic() < deadline:
                actual = tmux("show-options", "-wqv", "-t", target, "@pi_state").strip()
                if actual == expected:
                    return
                time.sleep(0.1)
            raise AssertionError(f"{target}: expected state {expected!r}, got {actual!r}")

        def send_command(target, text):
            tmux("send-keys", "-t", target, "-l", text)
            tmux("send-keys", "-t", target, "Enter")

        command = shlex.join([
            "env", f"PI_CODING_AGENT_DIR={agent}", "PI_OFFLINE=1",
            "pi", "--no-session", "--no-mcp", "--no-skills",
            "--no-context-files", "--no-prompt-templates", "--no-approve",
            "-e", str(probe),
        ])
        try:
            tmux("new-session", "-d", "-s", "footer", "-x", "140", "-y", "40",
                 "-c", str(work), command)
            wait_for("footer:0", "live-footer-before")
            wait_state("footer:0", "idle")
            send_command("footer:0", "/test-block")
            wait_state("footer:0", "blocked")
            send_command("footer:0", "/test-unblock")
            wait_state("footer:0", "idle")
            footer.write_text(source.replace(marker, 'const tokenParts: string[] = ["live-footer-after"];'))
            send_command("footer:0", "/reload")
            wait_for("footer:0", "live-footer-after")
            wait_state("footer:0", "idle")
            send_command("footer:0", "/test-block")
            wait_state("footer:0", "blocked")
            send_command("footer:0", "/test-unblock")
            wait_state("footer:0", "idle")
            tmux("new-window", "-d", "-t", "footer:1", "-c", str(work), command)
            wait_for("footer:1", "live-footer-after")
            wait_state("footer:1", "idle")
            current = json.loads(settings.read_text())
            assert current["packages"] == [str(package)]
            assert current["theme"] == "dark"
            assert not settings.is_symlink()
            assert os.access(settings, os.W_OK)
            print("PASS: live /reload, fresh window, tmux idle/blocked states, writable settings")
        finally:
            tmux("kill-server", check=False)


if __name__ == "__main__":
    main()
