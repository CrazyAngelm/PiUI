#!/usr/bin/env python3
"""Owned SPIKE-02 fixture: publish its PID, then sleep until host containment closes."""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--seconds", type=float, required=True)
    args = parser.parse_args()
    args.ready.write_text(f"{os.getpid()}\n", encoding="ascii", newline="\n")
    time.sleep(args.seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
