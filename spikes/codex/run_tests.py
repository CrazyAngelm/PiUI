#!/usr/bin/env python3
"""Run unit checks and the bounded native Codex integration probe."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

import probe

ROOT = Path(__file__).resolve().parent
REPORT = ROOT / "reports" / "verification.json"


def main() -> int:
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        return 1
    (ROOT / ".probe-work").mkdir(exist_ok=True)
    try:
        report = asyncio.run(probe.run_probe(None))
    except (OSError, probe.ProbeFailure, UnicodeError, json.JSONDecodeError) as error:
        print(f"Codex native probe failed: {error}", file=sys.stderr)
        return 1
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
