#!/usr/bin/env python3
"""Drive actual interactive Pi through a local faux provider. stdlib only; no tmux/network."""
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])")
BAD = re.compile(rb"(No more faux responses|Request was aborted|Provider error|Error loading extension|Disconnected)", re.I)

class Pi:
    def __init__(self, env, cwd, name):
        master, slave = pty.openpty()
        self.master = master
        self.name = name
        self.raw = bytearray()
        self.log = open(Path(env["PI_TOKEN_USAGE_E2E_ARTIFACTS"]) / (name + ".pty"), "wb")
        self.proc = subprocess.Popen(["pi", "-ne", "-ns", "-np", "-nc", "--offline", "--no-tools", "-e", str(ROOT / "src/index.ts"), "-e", str(ROOT / "test/e2e-provider.ts"), "--provider", "usage-e2e", "--model", "usage-e2e/scripted"], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, start_new_session=True, close_fds=True)
        os.close(slave)
    def read(self, wait=.05):
        if select.select([self.master], [], [], wait)[0]:
            try: chunk = os.read(self.master, 65536)
            except OSError: chunk = b""
            if chunk:
                self.raw.extend(chunk); self.log.write(chunk); self.log.flush()
        if self.proc.poll() is not None:
            raise AssertionError(f"{self.name} exited unexpectedly ({self.proc.returncode}): {self.text()[-1600:]}")
    def text(self):
        return ANSI.sub(b"", bytes(self.raw)).decode("utf-8", "replace")
    def wait(self, pattern, seconds=12, since=0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.read()
            if re.search(pattern, self.text()[since:], re.I | re.S): return self.text()[since:]
        raise AssertionError(f"{self.name}: missing {pattern!r}; last output:\n{self.text()[-1800:]}")
    def send(self, command):
        offset = len(self.text())
        os.write(self.master, command.encode())
        self.wait(re.escape(command), 6, offset)
        os.write(self.master, b"\r")
        return len(self.text())
    def stop(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try: self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL); self.proc.wait(timeout=5)
        os.close(self.master); self.log.close()
        if self.proc.poll() is None: raise AssertionError(f"{self.name} not cleaned")

def check_clean(text):
    assert not BAD.search(text.encode()), "interactive Pi error/disconnect observed"

def main():
    home = Path(tempfile.mkdtemp(prefix="pi-usage-e2e-"))
    agent = home / "agent"; agent.mkdir()
    captures = home / "captures"; captures.mkdir()
    project = home / "project"; project.mkdir()
    (project / ".pi-token-usage.json").write_text(json.dumps({"enabled": True, "items": ["totalTodayTokens"], "style": "plain"}))
    gate = home / "hold-import"; gate.touch()
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_TOKEN_USAGE_TEST_GATE=str(gate), PI_TOKEN_USAGE_E2E_ARTIFACTS=str(captures), PI_OFFLINE="1", TERM="xterm-256color", COLUMNS="130", LINES="55")
    # Proof capture workers may set this independently of PI_CODING_AGENT_DIR.
    # The scripted Pi processes must persist into the fixture tree being indexed.
    env.pop("PI_CODING_AGENT_SESSION_DIR", None)
    history = agent / "sessions" / "history" / "historical.jsonl"; history.parent.mkdir(parents=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
    def charge(id_, input_, cwd="/historical"):
        return {"type":"message", "id":id_, "parentId":None, "timestamp":now, "message":{"role":"assistant","provider":"scripted","model":"scripted","timestamp":int(time.time()*1000),"usage":{"input":input_,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":input_+2,"cost":{"total":0}}}}
    def source(path, cwd, entries):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(e) for e in [{"type":"session","version":3,"id":path.stem,"timestamp":now,"cwd":cwd}, *entries]) + "\n")
    historical_charge = charge("historical", 1200)
    source(history, "/historical", [historical_charge])
    processes = []
    try:
        first = Pi(env, project, "first"); processes.append(first)
        first.wait(r"Usage loading.*Total today", 20)
        at = first.send("respond using your scripted response")
        first.wait(r"SETTLED-USAGE-E2E-7F3A", 20, at)
        # Persisted answer confirms turn completion rather than mere streamed output.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            first.read()
            files = list((agent / "sessions").rglob("*.jsonl"))
            settled = False
            for p in files:
                for line in p.read_text().splitlines():
                    e = json.loads(line)
                    m = e.get("message", {})
                    if (e.get("type") == "message" and m.get("role") == "assistant"
                            and m.get("stopReason") == "stop"
                            and m.get("usage", {}).get("totalTokens", 0) > 0
                            and "SETTLED-USAGE-E2E-7F3A" in json.dumps(m.get("content"))):
                        settled = True
            if settled: break
        else: raise AssertionError("scripted turn did not persist")
        first.wait(r"Total today[^\r\n]*\b[1-9][0-9]* tok\b", 10, at)
        assert gate.exists(), "import gate released before own-turn footer"
        check_clean(first.text()[at:])
        print("PASS settled persisted prompt and same-process nonzero token footer with historical import gated")
        at = first.send("/usage footer off")
        first.wait(r"Footer disabled", 8, at)
        assert "Total today" not in first.text()[-350:], "disabled footer still displayed"
        at = first.send("/usage footer on")
        first.wait(r"Footer enabled", 8, at)
        first.wait(r"Total today", 8, at)
        assert "Total today" in first.text()[-350:], "enabled footer not displayed"
        print("PASS /usage footer off/on command and visible display toggle")
        at = first.send("/usage")
        first.wait(r"stale/incomplete.*catch-up timed out", 6, at)
        check_clean(first.text()[at:])
        print("PASS bounded /usage timeout warning")
        at = first.send("/new")
        first.wait(r"New session started", 10, at)
        assert gate.exists(), "old worker finished before session replacement"
        gate.unlink()
        at = first.send("/usage refresh")
        first.wait(r"Lifetime[^\r\n]*1\.[0-9][kK]", 12, at)
        first.wait(r"/historical[^\r\n]*1\.2[kK]", 12, at)
        first.wait(r"Total today[^\r\n]*\b[1-9][0-9]*(?:\.[0-9])?[kK]? tok\b", 12, at)
        print("PASS real /new session replacement while old import was pending")
        assert "stale/incomplete" not in first.text()[at:], "recovery still warned"
        print("PASS complete recovery and historical charge")
        second = Pi({k:v for k,v in env.items() if k != "PI_TOKEN_USAGE_TEST_GATE"}, project, "second"); processes.append(second)
        second.wait(r"Total today", 20)
        second.wait(r"Total today[^\r\n]*\b2\.[0-9][kK] tok\b", 12)
        print("PASS second real Pi process opens shared index")
        child = agent / "sessions" / "history" / "child" / "child.jsonl"
        child_charge = charge("child", 3400, "/another/child-project")
        source(child, "/another/child-project", [historical_charge, child_charge])
        idle_at = len(second.text())
        idle_start = time.monotonic()
        second.wait(r"Total today[^\r\n]*\b5\.[0-9][kK] tok\b", 60, idle_at)
        assert time.monotonic() - idle_start < 60, "idle shared update missed one-minute cadence"
        check_clean(second.text())
        at = second.send("/usage projects")
        second.wait(r"child-project", 8, at)
        at = second.send("/usage")
        second.wait(r"3 messages across 3 sessions", 8, at)
        assert "stale/incomplete" not in second.text()[at:]
        history.unlink()
        at = second.send("/usage refresh")
        second.wait(r"3 messages across 2 sessions", 8, at)
        assert "stale/incomplete" not in second.text()[at:]
        source(child, "/another/child-project", [child_charge])
        at = second.send("/usage refresh")
        second.wait(r"2 messages across 2 sessions", 8, at)
        second.wait(r"Total today[^\r\n]*\b4\.[0-9][kK] tok\b", 8, at)
        assert "stale/incomplete" not in second.text()[at:]
        check_clean(second.text())
        print("PASS idle child update under 60s, copied charge reassignment, last-source removal and child attribution")
        second.stop(); processes.remove(second)
        restarted = Pi({k:v for k,v in env.items() if k != "PI_TOKEN_USAGE_TEST_GATE"}, project, "restarted"); processes.append(restarted)
        restarted.wait(r"Total today[^\r\n]*\b4\.[0-9][kK] tok\b", 20)
        at = restarted.send("/usage")
        restarted.wait(r"2 messages across 2 sessions", 10, at)
        assert "stale/incomplete" not in restarted.text()[at:], "restarted process did not reuse complete shared index"
        check_clean(restarted.text())
        print("PASS stopped Pi process restarts against retained shared index")
        print(f"Captures: {captures}; sessions/index: {agent}")
    finally:
        gate.unlink(missing_ok=True)
        for p in reversed(processes): p.stop()
        assert all(p.proc.poll() is not None for p in processes), "Pi worker not cleaned"

if __name__ == "__main__":
    main()
