import { SvelteMap } from 'svelte/reactivity';
import type { HarnessKind } from '../../../../contracts/workspace-v15';
import { acpAgentId, isAcpHarness } from '../../../../contracts/harness-identity-v2';

/**
 * Presentation metadata for native harnesses. Labels and monograms only —
 * capabilities always come from the host catalog, never from this table.
 * Unknown harness ids (future registry entries) fall back to a neutral mark.
 */
export interface HarnessMeta {
  label: string;
  short: string;
  monogram: string;
  hue: string;
}

const META: Record<string, HarnessMeta> = {
  pi: { label: 'Pi', short: 'Pi', monogram: 'π', hue: '#d9a55b' },
  codex: { label: 'Codex', short: 'Codex', monogram: 'C', hue: '#8fb3e0' },
  'prime-agent': { label: 'Prime Agent', short: 'Prime', monogram: 'P', hue: '#b59be6' },
  hermes: { label: 'Hermes', short: 'Hermes', monogram: 'H', hue: '#7fc4b4' },
  'claude-code': { label: 'Claude Code', short: 'Claude', monogram: '✳', hue: '#e0957a' },
};

/** Muted hues for ACP agents, picked by a stable hash of the descriptor id. */
const ACP_HUES = ['#9ec27a', '#e0b86a', '#8fc7d6', '#d69ab8', '#b8b37f', '#a3a8e0'];

/** Display names of ACP agents as the host catalog reports them (reactive). */
const acpNames = new SvelteMap<string, string>();

/** Remember the host-provided names of ACP agents (`acp:<id>` identities). */
export function rememberHarnessNames(harnesses: readonly { kind: string; name: string }[]): void {
  for (const harness of harnesses) {
    if (isAcpHarness(harness.kind) && harness.name.trim() && acpNames.get(harness.kind) !== harness.name) {
      acpNames.set(harness.kind, harness.name);
    }
  }
}

function acpMeta(kind: `acp:${string}`): HarnessMeta {
  const id = acpAgentId(kind);
  const label = acpNames.get(kind) ?? id;
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { label, short: label, monogram: label.slice(0, 1).toUpperCase(), hue: ACP_HUES[hash % ACP_HUES.length] ?? '#a8a0aa' };
}

export function harnessMeta(kind: HarnessKind | string): HarnessMeta {
  const known = META[kind];
  if (known) return known;
  if (isAcpHarness(kind)) return acpMeta(kind);
  return { label: kind, short: kind, monogram: kind.slice(0, 1).toUpperCase(), hue: '#a8a0aa' };
}
