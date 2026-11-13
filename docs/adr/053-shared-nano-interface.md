# ADR-053 — Shared Nano interface with explicit work locations

Status: accepted for isolated implementation, 2026-11-13.

The owner authorized implementing the unification recommendation in separate
worktrees with read-only reviews and stage commits. The implementation contract
and evidence ledger are in [NANO_UNIFICATION.md](../NANO_UNIFICATION.md).

## Decision

Share Svelte presentation and semantic design tokens between Desktop and the
personal Nano web application. Introduce complete surfaces gradually into the
existing Blazor application; do not replace working scenarios before parity.
Nano's .NET backend remains authoritative for identity, workspace access,
entitlements, usage and server runtime services. A cloud graph host reuses
`piui-orchestration` for transition semantics rather than implementing a second
coordinator. Its versioned transport, persistence and native adapter must be
verified independently before cloud execution is advertised.

This computer and Nano Cloud are locations, independent of harness and model
source. Neither changing location nor importing a system transfers files,
starts execution or changes a running session's source. Native history remains
authoritative. An imported unsupported node is preserved or explicitly refused,
never silently removed or converted into another harness.

Nano is the built-in default design style; Chaos remains available. Style and
light/dark/system appearance are separate preferences. Existing plugin palette
contracts remain compatible. Styles may alter decoration but not obscure
trust, permission, location, error, cancellation or accessibility semantics.
No style asset requires a Nano network request.

Avatars are account services supplied by the server. The desktop's bundled
offline sprite is replaced by authenticated, entitlement-gated temporary
display. No account or unavailable capability means no avatar UI slot. Renderer
failure does not break chat, and status animation does not upload local text.

ADR-049's isolated cloud window remains the supported cloud surface during
migration. Remote content receives no IPC. A future bundled cloud surface
requires a versioned host-mediated API; common source code alone does not
establish that API or synchronized release delivery.

## Alternatives

Rewriting the .NET platform or both interfaces in Rust does not remove the
current UI duplication and would migrate unrelated working services. Retaining
independent UI implementations with only shared colors is a useful transition,
but not the intended endpoint for genuinely shared flows. A full Blazor-to-
Svelte replacement remains conditional on the graph and conversation proofs.

## Consequences

Shared surfaces require explicit data/capability ports and a single owner of
each DOM subtree. No browser fallback may accidentally select the UI Lab.
Clients and server update independently, so capability checks and compatible
contracts are required. Existing workflow engines and team task state retain
their ownership; graph execution cannot fabricate team-task identities.

This ADR creates no general remote shell, unrestricted proxy, new agent loop,
telemetry, production rollout or claim of sandboxing/platform release readiness.
