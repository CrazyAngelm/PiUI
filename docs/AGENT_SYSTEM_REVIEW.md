# Agent systems: research and implementation

2026-09-06. User outcome: configurable agents, teams and pipelines in PiUI,
Codex and Prime Agent, own prompts, directed communications, dynamic delegation
and efficient execution of hundreds of agents.

## Decision and GitHub research

Keep PiUI as the desktop shell. Managed Codex sessions now share the official
**Rust Codex app-server**, with native threads multiplexed per workspace and
Codex home. Prime retains its native SDK adapter. The model/tool loops,
credentials and authoritative histories stay in their respective harnesses.
One host-side JavaScript bridge remains for the shared Codex process.

The installed official Codex 0.147.0 is already Rust. Installing an arbitrary
Rust fork would not itself remove process-per-agent overhead.

| Repository | Verified finding | Decision |
|---|---|---|
| [Official Codex](https://github.com/openai/codex/tree/rust-v0.147.0) | Multiple concurrent native threads; installed experimental schema accepts `baseInstructions` | Selected and exercised locally |
| [Every Code](https://github.com/just-every/code) | Active Rust fork with orchestration/browser features. `code-rs/core/src/agent_tool.rs` still launches external CLI agents as child processes | Not evidence of the requested task-per-agent optimization |
| [Cometix](https://github.com/Haleclipse/codex) | Terminal UX, translation, personalities and other Rust Codex customizations | No verified hundred-agent advantage for PiUI |
| [stellarlinkco/codex](https://github.com/stellarlinkco/codex) | Agent teams and native thread management; archived repository, last update April 2026 | Not selected as the maintained default |
| [OpenCodex](https://github.com/lidge-jun/opencodex) | TypeScript/Bun routing and sidecars | Not the requested lightweight Rust replacement |

No public repository was verified as the video author's exact paid fork.
No third-party fork or global Codex replacement was installed.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) has SDK
profiles and a plugin architecture, but is a developer preview. Moving PiUI
into it would rebuild existing desktop/runtime integration. Its future role
can be another native adapter; see its
[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).

## Both video transcripts

Both supplied videos were transcribed **from their actual Russian YouTube
caption tracks**, downloaded using yt-dlp and converted to timestamped text.
This was caption extraction, not an independently run audio recognizer.
Automatic-caption spelling errors remain possible. Transcripts and metadata
are local ignored artifacts in `target/video-research/`; full copyrighted
transcripts are not published in this repository.

Reproduction requires yt-dlp:

```powershell
python -m yt_dlp --skip-download --write-subs --write-auto-subs --sub-langs ru --sub-format json3 --write-info-json -o "target/video-research/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=gNsjZvzdGEE" "https://www.youtube.com/watch?v=u3gbL1cEEUs"
```

### “Запустил 250 ИИ-агентов одновременно” — Олег Стефанов

- [04:01](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=241s): research agents and an editor; useful division of work matters more than role names.
- [08:15](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=495s): agents exchange information during an editing pipeline.
- [14:17](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=857s): reusable workflows encode order and result dependencies.
- [20:40](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=1240s): the author's fork removes much of the coding prompt and runs agents as tasks in one Rust process. Source access is described as part of his paid club.
- [23:15](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=1395s): profiles, permitted child types, groups and individual agent inspection.
- [27:27](https://www.youtube.com/watch?v=gNsjZvzdGEE&t=1647s): agents assemble teams dynamically; acceptance criteria and cost control still matter.

### “Заставил Kimi K3 найти все баги” — Олег Стефанов

- [02:35](https://www.youtube.com/watch?v=u3gbL1cEEUs&t=155s): Kimi Code testing workflow; not itself evidence of a public Codex fork.
- [05:00](https://www.youtube.com/watch?v=u3gbL1cEEUs&t=300s): concrete acceptance criteria improve bug finding and visual checks.
- [07:31](https://www.youtube.com/watch?v=u3gbL1cEEUs&t=451s): developer/reviewer exchanges can become endless; a coordinator filters consequential work.
- [08:21](https://www.youtube.com/watch?v=u3gbL1cEEUs&t=501s): lead, developer and tester use shared and task-specific groups. Cost reductions are the author's reported experience, not an independent benchmark.

## Implemented behavior

| Request | Result |
|---|---|
| Codex and Prime | Native Codex 0.147.0; Prime 0.9.2 and verified 0.9.3 SDK compatibility |
| Own prompts | Additive instructions plus optional Codex base replacement, including explicit empty text |
| Many Codex agents | Shared native process for managed sessions; separate request IDs, events and approvals |
| Dynamic agents | `workspace.spawn_agent` creates a task/member from an allowed snapshotted profile; task text cannot override tools or permissions |
| Collect results | `workspace.wait` waits for an observed member's current task and returns its latest assistant result; caller cancellation ends the wait |
| Directed communication | Separate incoming/outgoing messaging and observation; orchestrator/all-to-all presets |
| Dynamic peers | Explicit team option lets spawned agents message the team; absent option retains parent-only messaging |
| Saved workflows | Persisted teams, dependency pipelines and reusable launch commands |
| Large-run inspection | Agent/task search, status filters, native-session links, linear member/profile lookup |
| Less clutter | Legacy history navigation and alternate history page removed; empty approval/activity shortcuts hidden; chat filters contextual; advanced profile/subagent controls collapsed |

New members extend the effective run graph. `initialDefinition` retains the
original launch graph. Saved definitions do not change. Typed requests and
leases are journaled before side effects; uncertain work is not blindly replayed.

This is not a full clone of the video's product: arbitrary named runtime
channels, model-authored security profiles and a freeform node canvas are not
implemented. Finished one-shot tasks are not permanent autonomous participants;
the parent should collect child results with `wait` before completing itself.

## Empty prompt and permission boundaries

A local synthetic Responses endpoint confirmed that `baseInstructions`
replaces the coding base exactly. Explicit empty text produced no base
`instructions` text in the outgoing request. Developer/project context, native
permissions, tool descriptions and model-level behavior still exist.
Empty base text must not be described as a completely context-free model.
The [official documentation](https://learn.chatgpt.com/docs/config-file/config-advanced)
also distinguishes base replacement from additive developer instructions.

Arbitrary native Codex tool allowlisting is not advertised. Unsupported
mandatory restrictions reject launch. Prime tool filtering uses the native
SDK. Prompt text and coordinator messaging policy are never OS sandboxes.

## Evidence and limits

- Native Rust app-server: **200 simultaneous local model requests, 200 correctly attributed results, one native process**. RSS after turns: **259,588,096 bytes (247.6 MiB)**, for that Rust process only. `target/codex-scale-oM3yrQ/report.json`.
- PiUI multiplex adapter: **200/200 correct results**, independent close. Initialization 33.9 s, total through result collection 48.4 s. `target/codex-pool-eUtlCJ/report.json`.
- Parallel thread-start admission originally produced native `-32001 Server overloaded`. Control requests now await acknowledgements while model turns execute concurrently. 200 is a benchmark input derived from the user's request for hundreds, not an application limit.
- These are isolated local-provider transport tests, not paid/authenticated production workloads. They do not measure model quality, provider quotas or heavy tools. Desktop/WebView memory is additional.
- Actual Codex lifecycle through the Rust PiUI host proves shared ownership and independent close. Adapter fixtures cover active cancellation, output isolation and shared native failure. Closed sessions unsubscribe their native threads.
- Actual Prime 0.9.3 lifecycle passed using an explicit non-default daemon endpoint; no default daemon was probed or restarted.
- Windows WebView2 E2E after clutter removal: `target/piui-evidence/11076-1788701993857/report.json`. Prompt persistence, team policy, CRUD, denied launch, native close/reopen, safe mode and zero remaining owned processes pass. Linux lifecycle remains unverified.
- `pnpm check`, UI/unit contracts, Rust workspace tests and clippy are required gates. Asset smoke measures bundle size only; native screenshots include separate owned-process memory snapshots.

Local probes: `scripts/codex-prompt-probe.mjs` (also `--empty`),
`scripts/codex-scale-probe.mjs 200`, `scripts/codex-pool-probe.mjs 200`,
`scripts/prime-lifecycle-probe.mjs --daemon-socket <non-default-endpoint>`.
Use the repository's Windows `piui-e2e-job` containment runner. Scale scripts
default to the Windows npm native binary; `PIUI_CODEX_BINARY` overrides it.
