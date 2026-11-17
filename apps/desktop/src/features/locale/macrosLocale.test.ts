import { describe, expect, it } from 'vitest';
import { lookupRussian } from './ruCatalog';
import { macrosRu } from './ru/macros';

const strings = [
  'Macros', 'New macro', 'Edit macro', 'Edit //{0}', 'Delete //{0}', 'Deleted //{0}',
  'No macros yet', 'A macro is a saved prompt or a set of skills. Press Space in an empty message, or Space twice after text, to add one.',
  'Name', 'Description', 'Skills', 'Prompt', 'optional', 'Cancel', 'Save', 'Close', 'Undo',
  'No matching macros', 'Manage macros', 'Edit the macro at the caret',
  'Macros could not be saved on this device. They last until the app closes.',
  'Enter a name.', 'The name is too long.', 'Use letters, digits, hyphens and underscores.',
  'Another macro already has this name.', 'Too many macros. Delete one first.',
  'The description is too long.', 'Too many skills.',
  'Skill names use letters, digits, dots, colons, hyphens and underscores.',
  'Add a prompt or at least one skill.', 'The prompt is too long.',
];

describe('macro Russian copy', () => {
  it.each(strings)('translates %s through the catalog', (source) => {
    expect(lookupRussian(source), source).toBeTruthy();
    expect(lookupRussian(source), source).not.toBe(source);
  });
  it('keeps the field vocabulary and placeholders', () => {
    for (const [key, expected] of Object.entries({ Name: 'Имя', Description: 'Описание', Skills: 'Навыки', Prompt: 'Промпт' })) expect(lookupRussian(key)).toBe(expected);
    for (const source of ['Edit //{0}', 'Delete //{0}', 'Deleted //{0}']) expect(lookupRussian(source)).toContain('//{0}');
    for (const [key, translated] of Object.entries(macrosRu)) expect(lookupRussian(key)).toBe(translated);
  });
});
