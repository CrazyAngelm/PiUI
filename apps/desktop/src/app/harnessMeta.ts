import type { HarnessKind } from '../../../../contracts/workspace-v15';

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

export function harnessMeta(kind: HarnessKind | string): HarnessMeta {
  return META[kind] ?? { label: kind, short: kind, monogram: kind.slice(0, 1).toUpperCase(), hue: '#a8a0aa' };
}
