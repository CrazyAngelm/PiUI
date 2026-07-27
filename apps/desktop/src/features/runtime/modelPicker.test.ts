import { describe, expect, it } from 'vitest';
import type { ModelLite } from '../../host-api/types';
import {
  filterModelPickerOptions,
  modelDisplayName,
  modelIsAvailable,
  orderModelPickerOptions,
  providerDisplayName,
} from './modelPicker';

const models: ModelLite[] = [
  { provider: 'openai-codex', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { provider: 'openai-codex', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { provider: 'opencode-go', id: 'kimi-k3', label: 'Kimi K3 (2x usage)' },
];

describe('model picker projection', () => {
  it('uses the human label without repeating provider and technical id', () => {
    expect(modelDisplayName(models[0])).toBe('GPT-5.6 Luna');
    expect(providerDisplayName('openai-codex')).toBe('OpenAI Codex');
    expect(providerDisplayName('opencode-go')).toBe('OpenCode Go');
  });

  it('keeps an unavailable current model visible instead of substituting the first catalog row', () => {
    const unavailable = { provider: 'custom-provider', id: 'retired-model', label: 'Retired model' };

    expect(modelIsAvailable(models, unavailable)).toBe(false);
    expect(orderModelPickerOptions(models, unavailable)[0]).toEqual(unavailable);
  });

  it('keeps hidden provider and id text searchable', () => {
    expect(filterModelPickerOptions(models, 'luna')).toEqual([models[0]]);
    expect(filterModelPickerOptions(models, 'opencode kimi-k3')).toEqual([models[2]]);
  });

  it('preserves provider order while grouping each provider together', () => {
    expect(filterModelPickerOptions([models[2], models[0], models[1]], '').map((model) => model.id)).toEqual([
      'kimi-k3',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
    ]);
  });
});
