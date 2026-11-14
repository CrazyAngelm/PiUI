import { describe, expect, it } from 'vitest';
import { defaultTab, favoriteKey, visibleModels } from './modelPickerView';

function model(provider: string | undefined, id: string) {
  return { key: `custom:${provider ?? ''}:${id}`, id, ...(provider ? { provider } : {}) };
}

const mini = model('openai', 'mini');
const codex = model('openai', 'codex');
const local = model(undefined, 'local');
const models = [mini, codex, local];

describe('defaultTab', () => {
  it('opens All models without favorites', () => {
    expect(defaultTab(models, [])).toBe('all');
  });

  it('opens Favorites when a favorite is in the list', () => {
    expect(defaultTab(models, [favoriteKey(codex)])).toBe('favorites');
    expect(defaultTab(models, [favoriteKey(local)])).toBe('favorites');
  });

  it('opens All models when no favorite is in the list any more', () => {
    expect(defaultTab(models, [favoriteKey({ provider: 'openai', id: 'removed' })])).toBe('all');
    expect(defaultTab([], [favoriteKey(codex)])).toBe('all');
  });
});

describe('favoriteKey', () => {
  it('does not depend on the caller key format and tells provider-less models apart', () => {
    expect(favoriteKey(codex)).toBe(JSON.stringify(['openai', 'codex']));
    expect(favoriteKey(local)).toBe(JSON.stringify([null, 'local']));
  });
});

describe('visibleModels', () => {
  const base = { search: '', favorites: [favoriteKey(codex)], value: '' };

  it('lists everything on All models', () => {
    expect(visibleModels(models, { ...base, tab: 'all' })).toEqual(models);
  });

  it('lists only favorites on Favorites', () => {
    expect(visibleModels(models, { ...base, tab: 'favorites' })).toEqual([codex]);
  });

  it('keeps the selected model even when it is not a favorite', () => {
    expect(visibleModels(models, { ...base, tab: 'favorites', value: mini.key })).toEqual([mini, codex]);
  });

  it('keeps a model that was un-favorited in this view', () => {
    expect(visibleModels(models, { ...base, favorites: [], tab: 'favorites', kept: [favoriteKey(codex)] })).toEqual([codex]);
  });

  it('shows nothing for no favorites and no selection', () => {
    expect(visibleModels(models, { ...base, favorites: [], tab: 'favorites' })).toEqual([]);
  });

  it('searches all models whatever the tab', () => {
    expect(visibleModels(models, { ...base, tab: 'favorites', search: 'mi' })).toEqual(models);
    expect(visibleModels(models, { ...base, tab: 'favorites', search: '   ' })).toEqual([codex]);
  });

  it('keeps the list order', () => {
    const all = [mini, codex, local];
    expect(visibleModels(all, { ...base, favorites: [favoriteKey(local), favoriteKey(mini)], tab: 'favorites' })).toEqual([mini, local]);
  });
});
