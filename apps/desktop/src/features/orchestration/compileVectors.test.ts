import { describe, expect, it } from 'vitest';
import { GRAPH_COMPILE_REFUSALS_V2 } from '../../../../../contracts/nano-graph-kernel-v2';
import { COMPILE_CASES, COMPILE_VECTORS_FILE, generateCompileVectors } from './compileVectors';

describe('graph compile vectors (ADR-059)', () => {
  // The generator itself fails when an editor outcome is not the one a case
  // expects, when a definition changes on the version 5 export, or when a
  // generated identifier survives normalization.
  const file = generateCompileVectors();

  it('matches the committed vector file, so the editor import path cannot drift unnoticed', async () => {
    await expect(`${JSON.stringify(file, null, 2)}\n`).toMatchFileSnapshot(COMPILE_VECTORS_FILE);
  });

  it('covers every shipped example and every refusal code it uses', () => {
    const sources = new Set(file.vectors.map((vector) => vector.source));
    for (const name of ['single', 'parallel-synthesis', 'mixed-review', 'codex-hermes-review', 'agent-script-llm', 'codex-claude-pi-review',
      'codex-gemini-acp-review', 'routed-review', 'structured-review', 'codex-nano-pi-review', 'development-with-testing', 'testing']) {
      expect(sources).toContain(`examples/systems/${name}.piui.json`);
    }
    for (const vector of file.vectors) {
      if (vector.rust.outcome === 'refused') expect(GRAPH_COMPILE_REFUSALS_V2).toContain(vector.rust.refusal);
    }
    expect(file.vectors).toHaveLength(COMPILE_CASES.length);
  });

  it('labels every server outcome as a prediction', () => {
    for (const vector of file.vectors) expect(vector.server.status).toBe('predicted');
    expect(file.server.status).toMatch(/^predicted/);
  });
});
