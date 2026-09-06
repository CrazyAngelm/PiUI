# Prime Agent 0.9.2 SDK lifecycle spike

This spike executes the installed `prime-agent@0.9.2` package through its documented SDK. It never invokes the Prime CLI or daemon.

## Safety

The launcher requires all of these explicit inputs:

- installed package root;
- isolated fixture workspace;
- an existing Prime kernel-runtime Python executable;
- a unique non-default daemon socket guard.

The daemon socket is accepted only as a guard and is never opened. The tests replace home/config directories, use in-memory auth/settings, disable telemetry, disable discovered extensions/skills/prompts/themes/context files, and use a synthetic in-process model stream. They do not read `auth.json`, inspect user sessions, or call a provider.

## Run

Python 3.13+, Node 22+, and a Python executable with the installed Prime 0.9.2 `rlm` runtime are required.

```powershell
py -3.13 spikes/prime-agent-092/run_tests.py `
  --package-root "$env:APPDATA/npm/node_modules/prime-agent" `
  --kernel-python "$HOME/.prime/agent/kernel-venv/Scripts/python.exe"

py -3.13 spikes/prime-agent-092/probe.py `
  --package-root "$env:APPDATA/npm/node_modules/prime-agent" `
  --report spikes/prime-agent-092/reports/latest.json
```

The Python client and Node host both frame JSON by LF byte only. They do not use Unicode-aware line readers for the bridge protocol.

## Diagnose initialization

The stage-only diagnostic exercises SDK import, native settings/model metadata, resources, session/runtime creation, extension binding, state, model catalog, and disposal. It uses empty in-memory auth, does not call a provider or daemon, and never emits raw errors or configuration values.

```powershell
py -3.13 spikes/prime-agent-092/diagnose_init.py `
  --package-root "$env:APPDATA/npm/node_modules/prime-agent" `
  --agent-dir "$HOME/.prime/agent" `
  --preserve-native-home `
  --no-extensions `
  --report spikes/prime-agent-092/reports/init-diagnostic-native-home-no-extensions.json
```

On the measured Windows host this completed in 3.95 seconds. SDK import took 3.54 seconds. All later stages completed in less than 241 milliseconds each. This proves the credential-free SDK construction path is not intrinsically close to the supervisor's 20-second request watchdog. A separate root E2E completed Prime's actual zero-turn initialization through the contained native supervisor with an empty native home and credential-free environment. That result also clears the stdin bootstrap and supervisor protocol from the generic failure path.

Prime's native initial model selection calls `ModelRegistry.refreshAvailableModels()`. For configured Prime team credentials and a cache miss, that method can make a model-catalog request with a 10-second upstream timeout. Global extensions and credential refresh are also configuration-dependent inputs excluded from this safe probe. They remain candidate stages, not a proven cause, for the environment-dependent full-resource timeout. Native session create/open follows PiUI first paint and explicit user action.

The adapter reuses the already-refreshed registry's fast `getAvailable()` result for its initial snapshot. An explicit `models()` request still invokes Prime's native refreshing API. After this change, the contained live Prime test passed in the current configured native environment: native model selection, explicit model refresh, a real exact-marker turn with explicit `Succeeded`, clean disposal, and same-session resume all completed within their unchanged per-operation watchdogs. PiUI did not inspect, log, modify, or copy native authentication/settings, and the SDK did not contact the daemon guard. This proves the current configured path while leaving the earlier transient's exact environmental cause unknown. The evidence requires no supervisor API change.

## Files

- `sdk-host.mjs`: reusable isolated SDK child and LF JSON fixture protocol.
- `descendant-fixture.mjs`: inert child/grandchild used to prove abort and owner containment.
- `tests/test_lifecycle.py`: real package lifecycle, native tool/RLM, EOF, abort, and process-tree checks.
- `probe.py`: static version/API/artifact hash report.
- `diagnose-init.mjs` and `diagnose_init.py`: safe stage-timing probe and bounded process owner.
- `reports/init-diagnostic-native-home-no-extensions.json`: sanitized stage timings from the native-home/no-extension run.
- `DECISION.md`: accepted route, capabilities, limitations, and production conditions.
- `reports/latest.json`: pinned installed and spike artifact hashes.
- `reports/test-results.txt`: executed native test summary.
