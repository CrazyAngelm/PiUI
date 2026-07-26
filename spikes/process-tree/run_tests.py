#!/usr/bin/env python3
"""Portable unit-test entrypoint for SPIKE-02; requires Python 3.13+."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

if sys.version_info < (3, 13):
    raise SystemExit("Python 3.13 or newer is required")

suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent / "tests"))
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(not result.wasSuccessful())
