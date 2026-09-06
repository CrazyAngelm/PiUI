#!/usr/bin/env python3
from __future__ import annotations
import argparse
import os
from pathlib import Path
import sys
import unittest

if sys.version_info < (3, 13):
    raise SystemExit("Python 3.13 or newer is required")
parser = argparse.ArgumentParser()
parser.add_argument("--package-root", type=Path, required=True)
parser.add_argument("--kernel-python", type=Path, required=True)
args = parser.parse_args()
os.environ["PIUI_PRIME_092_PACKAGE_ROOT"] = str(args.package_root.resolve(strict=True))
os.environ["PIUI_PRIME_092_KERNEL_PYTHON"] = str(args.kernel_python.resolve(strict=True))
suite = unittest.defaultTestLoader.discover(str(Path(__file__).resolve().parent / "tests"))
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(not result.wasSuccessful())
