import { describe, expect, it } from 'vitest';
import { failureAdvice } from './runGraph';

describe('failureAdvice', () => {
  it('tells a person what to change for the cause the adapter named', () => {
    expect(failureAdvice('native-turn-failed', 'The selected Pi model is unavailable.')).toContain('Edit pipeline');
    expect(failureAdvice('native-turn-failed', 'The Pi runtime could not authenticate the selected model.')).toContain('Sign in');
    expect(failureAdvice('native-turn-failed', 'The model provider reports no credits or quota left on this account.')).toContain('credits');
  });

  it('points an unnamed or unknown failure to the step chat', () => {
    for (const detail of [undefined, 'The Pi turn failed.', 'Something the adapter said', 'constructor', '__proto__', 'toString']) {
      expect(failureAdvice('native-turn-failed', detail)).toContain('Open the agent history of this step');
    }
  });

  it('adds nothing to failures that are not a native turn', () => {
    expect(failureAdvice('script-failed', 'Error: boom')).toBeUndefined();
    expect(failureAdvice('dependency-failed', undefined)).toBeUndefined();
  });
});
