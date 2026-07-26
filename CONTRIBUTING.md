# Contributing to PiUI

Thanks for helping improve PiUI.

## Before you start

- Read [README.md](README.md), [AGENTS.md](AGENTS.md), and the relevant documents under `docs/`.
- Keep PiUI a desktop shell over Pi. Do not add an agent loop, provider client, direct JSONL writer, cloud backend, telemetry, or unrestricted WebView shell/filesystem access.
- For changes that alter IPC, update the versioned contract under `contracts/`, add compatibility coverage, and document the behavior.
- For a new core feature, first decide whether it belongs in an extension contribution instead.

## Development workflow

1. Create a focused branch from `main`.
2. Make the smallest coherent change.
3. Add or update tests for the happy path and at least one failure path.
4. Update product, architecture, or contract documentation when behavior changes.
5. Run the relevant checks before opening a pull request.

```bash
pnpm repo:check
pnpm check
pnpm test
pnpm contract:test
pnpm build
pnpm test:e2e
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For correctness-sensitive index, parser, identity, or state-machine changes, also run the targeted mutation gate described in [docs/08_TESTING_AND_PERFORMANCE.md](docs/08_TESTING_AND_PERFORMANCE.md).

## Privacy and repository hygiene

Never commit:

- Pi session JSONL, prompts, tool output, screenshots from real sessions, or agent artifacts;
- `auth.json`, API keys, OAuth tokens, `.env` files, private certificates, or package-manager credentials;
- absolute local paths, usernames, private email addresses, or machine-specific diagnostics;
- build products, local SQLite databases, mutation output, or Python bytecode.

Before opening a pull request, inspect what Git will include:

```bash
git status --short
git diff --check
git ls-files --others --exclude-standard
```

## Pull requests

Keep pull requests reviewable and include:

- the user-visible or technical intent;
- affected contracts and migration/compatibility notes;
- tests run and their results;
- known limitations or follow-up work;
- performance impact when a hot path changes.

Do not claim a release, sandbox, managed-runtime guarantee, or platform support that has not passed the documented gate.

## Code of conduct and security

By participating, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through public issues.
