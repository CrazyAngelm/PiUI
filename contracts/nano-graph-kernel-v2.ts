/** Graph compile boundary (ADR-059, Proposed in Stage 0 of the unified shell).
 *
 * A portable system document of version 5 becomes the orchestration v6 run
 * definition or one refusal code. This file freezes only the compile input,
 * output and refusal codes of `piui_orchestration::compile_system_document`
 * (`crates/piui-orchestration/src/compile.rs`). It does not define kernel
 * protocol 2 commands, location bindings, capability admission or a refusal
 * matrix: those are unresolved in ADR-059. Protocol 1
 * (`nano-graph-kernel-v1.ts`) is unchanged and still refuses scripts, plugin
 * nodes, sub-pipelines, callable roles, delegation and team messaging.
 *
 * Compiling grants nothing and starts nothing: the definition is a draft
 * until a host freezes it in a run after its own admission checks.
 * Equality vectors generated from the editor's import path are
 * `fixtures/unified-shell/graph/compile-vectors-v1.json`.
 */
import type { RunDefinitionSnapshot } from './orchestration-v6';

/** The only document version compiled. The editor's import parser upgrades versions 1-4. */
export const GRAPH_COMPILE_DOCUMENT_VERSION_V2 = 5;

/**
 * Identifiers chosen by the host, never by the document. The profile and the
 * team member of an agent both take the agent's local id.
 */
export interface GraphCompileIdentityV2 {
  readonly teamId: string;
  readonly pipelineId: string;
  /**
   * With an id the definition carries the launch command
   * `{id, name: <document name>, teamId, pipelineId}`, as the Desktop editor
   * saves a graph. Without one it carries none, as the server's drafts do.
   */
  readonly launchCommandId?: string;
}

/**
 * A saved launch command that a sub-pipeline step's pipeline NAME resolves
 * against: the exact name, else a unique case-insensitive match. A missing or
 * ambiguous name is refused, never replaced.
 */
export interface GraphPipelineNameV2 {
  readonly id: string;
  readonly name: string;
}

export interface GraphCompileInputV2 {
  /** The exact document text: repeated member names and number spelling are checked on it. */
  readonly document: string;
  readonly identity: GraphCompileIdentityV2;
  readonly pipelines: readonly GraphPipelineNameV2[];
}

/** Stable refusal codes, in the order the compiler checks them. */
export const GRAPH_COMPILE_REFUSALS_V2 = [
  /** Not one JSON value the parser reads (syntax, or nesting beyond serde_json's recursion limit). */
  'invalidJson',
  /** Not an object with `format: "piui-system"` and a numeric `version`. */
  'notSystemFile',
  /** A version other than 5. */
  'unsupportedVersion',
  /** Not system file v5: unknown, missing, null or mistyped member, schema pattern or range, or a repeated member name. */
  'invalidDocument',
  /** Agents and connections the mapping cannot represent without dropping or replacing a member. */
  'invalidStructure',
  /** A sub-pipeline names a pipeline missing or ambiguous among the supplied ones. */
  'unresolvedPipeline',
  /** A sub-pipeline names the launch command being compiled. */
  'selfReferencingPipeline',
  /** The definition fails `validate_definition` or an editor graph rule. */
  'invalidDefinition',
  /** A delegation grant fails `authorize_spawn` (same-or-less authority). */
  'delegationDenied',
] as const;

export type GraphCompileRefusalV2 = (typeof GRAPH_COMPILE_REFUSALS_V2)[number];

export type GraphCompileResultV2 =
  | { readonly outcome: 'compiled'; readonly definition: RunDefinitionSnapshot }
  | { readonly outcome: 'refused'; readonly refusal: GraphCompileRefusalV2 };
