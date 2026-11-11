import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legacyRu } from '../legacyRu';
import { russianUi } from '../russianUi';
import { shellRu } from '../shellRu';

type Catalog = Readonly<Record<string, string>>;

/** Every exported catalog of every `ru/*.ts` module, so a new feature file is covered without editing this test. */
async function featureCatalogs(): Promise<[string, Catalog][]> {
  const names = readdirSync(new URL('./', import.meta.url))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => name.slice(0, -'.ts'.length));
  const catalogs: [string, Catalog][] = [];
  for (const name of names) {
    const module = (await import(/* @vite-ignore */ `./${name}`)) as Record<string, unknown>;
    for (const [exported, value] of Object.entries(module)) {
      if (value !== null && typeof value === 'object') catalogs.push([`ru/${name}.ts ${exported}`, value as Catalog]);
    }
  }
  return catalogs;
}

describe('Russian copy has no harness jargon', () => {
  it('uses "агент" or "программа агента" instead of «харнес» in every catalog value', async () => {
    const catalogs: [string, Catalog][] = [
      ['shellRu.ts', shellRu],
      ['legacyRu.ts', legacyRu],
      ['russianUi.ts', russianUi],
      ...(await featureCatalogs()),
    ];
    expect(catalogs.length).toBeGreaterThan(15);
    const offenders = catalogs.flatMap(([source, catalog]) =>
      Object.entries(catalog)
        .filter(([, value]) => /харнес/i.test(value))
        .map(([key, value]) => `${source}: ${key} -> ${value}`),
    );
    expect(offenders).toEqual([]);
  });
  it('resolves the picker terms and harness status reasons through the merged lookup', async () => {
    const { lookupRussian } = await import('../ruCatalog');
    expect(lookupRussian('Harness'), 'differs from the Agent tab next to it').toBe('Программа агента');
    expect(lookupRussian('Harness directly')).toBe('Напрямую агенту');
    expect(lookupRussian('The native harness is not installed.')).toBe('Агент не установлен.');
    expect(lookupRussian("The agent's program was not found on PATH.")).toBe('Программа агента не найдена в PATH.');
  });
});
