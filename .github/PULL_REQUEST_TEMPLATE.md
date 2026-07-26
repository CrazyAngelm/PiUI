## Summary

Describe the user-visible or technical change.

## Validation

- [ ] `pnpm repo:check`
- [ ] Relevant frontend checks (`pnpm check`, `pnpm test`, `pnpm build`)
- [ ] Relevant Rust checks (`cargo fmt`, `cargo clippy`, `cargo test`)
- [ ] Contract/schema compatibility checks, if IPC changed
- [ ] Documentation updated when behavior changed
- [ ] Mutation testing run for correctness-sensitive parser/index/state changes

## Privacy and release hygiene

- [ ] No credentials, personal paths, session JSONL, prompts, tool output, agent state, or private screenshots are included.
- [ ] No generated build/mutation/cache artifacts are included.
- [ ] New dependencies, licenses, and source provenance were reviewed.

## Risks and rollback

Describe relevant data, security, performance, platform, or compatibility risks. State how to roll back if needed.
