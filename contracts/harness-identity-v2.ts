/**
 * PiUI harness identity grammar v2 (ADR-028, ADR-034).
 *
 * v1 was the closed set of built-in harness names. v2 keeps every v1 value with
 * its exact meaning and adds `acp:<descriptor id>`: an Agent Client Protocol
 * agent described by one registry descriptor (`acp-agent-descriptor-v1`). The
 * contracts that carry a harness (workspace v15 `HarnessKind`, orchestration v6
 * `Harness`, portable system files v4) accept v2 additively: no command, event
 * or field changed. A v1 consumer rejects an `acp:` value explicitly.
 */
export const HARNESS_IDENTITY_VERSION = 2 as const;

export type BuiltinHarness = 'pi' | 'prime-agent' | 'codex' | 'hermes' | 'claude-code';
export const BUILTIN_HARNESSES: readonly BuiltinHarness[] = ['pi', 'prime-agent', 'codex', 'hermes', 'claude-code'];

/** `acp:` followed by a descriptor id that matches {@link ACP_AGENT_ID_PATTERN}. */
export type AcpHarnessId = `acp:${string}`;
export type HarnessId = BuiltinHarness | AcpHarnessId;

export const ACP_HARNESS_PREFIX = 'acp:' as const;
/** Lowercase slug of 1-32 letters, digits and single inner hyphens. */
export const ACP_AGENT_ID_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isBuiltinHarness(value: string): value is BuiltinHarness {
  return (BUILTIN_HARNESSES as readonly string[]).includes(value);
}

export function isAcpHarness(value: string): value is AcpHarnessId {
  return value.startsWith(ACP_HARNESS_PREFIX) && ACP_AGENT_ID_PATTERN.test(value.slice(ACP_HARNESS_PREFIX.length));
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (isBuiltinHarness(value) || isAcpHarness(value));
}

/** The descriptor id of an ACP identity (`acp:gemini-cli` -> `gemini-cli`). */
export function acpAgentId(harness: AcpHarnessId): string {
  return harness.slice(ACP_HARNESS_PREFIX.length);
}

export function acpHarnessId(agentId: string): AcpHarnessId {
  return `${ACP_HARNESS_PREFIX}${agentId}`;
}
