#!/usr/bin/env python3
"""Controlled process tree used only by the Codex containment spike."""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

FIXTURE_LIFETIME_SECONDS = 30


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("role", choices=("root", "descendant"))
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    if args.role == "root":
        child = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(args.root), "descendant"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        (args.root / "root.pid").write_text(str(__import__("os").getpid()), encoding="ascii")
        (args.root / "descendant.expected.pid").write_text(str(child.pid), encoding="ascii")
        time.sleep(FIXTURE_LIFETIME_SECONDS)
        child.wait(timeout=5)
        return 0
    (args.root / "descendant.pid").write_text(str(__import__("os").getpid()), encoding="ascii")
    time.sleep(FIXTURE_LIFETIME_SECONDS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
