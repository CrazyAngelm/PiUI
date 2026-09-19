import { describe, expect, it } from 'vitest';
import { selectedRuntimeModel, effortName } from './runtimePickerState';
describe('runtime picker selection', () => {
  const active = { id: 'current', provider: 'native', name: 'Current' };
  it('retains an active model missing from the catalog', () => {
    expect(selectedRuntimeModel([], active)).toEqual(active);
    expect(selectedRuntimeModel([], active)?.thinkingLevels).toBeUndefined();
  });
  it('uses native capabilities only for the exact model and provider', () => {
    const wrong = { ...active, provider: 'other', thinkingLevels: ['wrong'] };
    const correct = { ...active, name: 'Native display name', thinkingLevels: ['low', 'ultra'] };
    expect(selectedRuntimeModel([wrong], active)).toEqual(active);
    expect(selectedRuntimeModel([wrong, correct], active)).toEqual(correct);
  });
  it('labels levels without changing unknown native values', () => {
    expect(effortName('xhigh')).toBe('Very high');
    expect(effortName('future-level')).toBe('future-level');
  });
});
