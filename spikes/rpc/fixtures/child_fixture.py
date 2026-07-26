#!/usr/bin/env python3
"""Synthetic SPIKE-02 child: writes readiness then sleeps until terminated."""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--ready", type=Path, required=True)
parser.add_argument("--seconds", type=float, default=30.0)
args = parser.parse_args()
args.ready.write_text(f"{os.getpid()}\n", encoding="ascii")
time.sleep(args.seconds)
