import { describe, expect, it } from 'vitest';
import { modelSelectionKey, resolveModelSelection } from './modelSelection';

describe('resolve a remembered model selection', () => {
  const id = 'gpt-5';
  const legacy = modelSelectionKey({ provider: 'openai', id });
  const implicit = { id };
  const different = { id, provider: 'other' };

  it('resolves a legacy Codex OpenAI key against a unique implicit model', () => {
    expect(resolveModelSelection([implicit], legacy, 'codex')).toBe(implicit);
    expect(resolveModelSelection([{ id, provider: null }], legacy, 'codex')).toEqual({ id, provider: null });
  });

  it('keeps exact provider matches and refuses mismatches or ambiguous implicit matches', () => {
    const exact = { id, provider: 'openai' };
    expect(resolveModelSelection([different, exact], legacy, 'codex')).toBe(exact);
    expect(resolveModelSelection([different], legacy, 'codex')).toBeUndefined();
    expect(resolveModelSelection([different, implicit], legacy, 'codex')).toBeUndefined();
    expect(resolveModelSelection([implicit], legacy, 'pi')).toBeUndefined();
    expect(resolveModelSelection([implicit], modelSelectionKey(different), 'codex')).toBeUndefined();
  });
});
