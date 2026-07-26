# SPIKE-08 baseline measurement

- Generated: 2026-07-23T17:11:47.527Z
- Status: **inconclusive**
- Host: Windows_NT 10.0.26200 (x64)
- WebView version: not recorded

## Required physical-machine measurements

| Metric | Status | Required method |
| --- | --- | --- |
| Cold/warm startup | Inconclusive | 20 packaged-release runs; record p50/p95 |
| Idle RSS / CPU | Inconclusive | Visible window, normal shell, no Pi runtime, 60 s sample |
| 10k-block scroll | Inconclusive | Open ?fixture=10k, capture frame times and long tasks |
| Platform rendering | Inconclusive | Check WebView2 and WebKitGTK reference machines |
| iframe/worker isolation | Not run | Deliberately outside this no-plugin shell |

No display, RSS, CPU, startup, or scroll budget has been passed. Replace each metric's status, samples, hardware profile, WebView version, and measurement method in the JSON report only after physical reference-hardware collection.
