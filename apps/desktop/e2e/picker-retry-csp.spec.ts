import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

interface BuildChunk { file: string; imports?: string[]; css?: string[] }
type BuildManifest = Record<string, BuildChunk>;
const panels = [
  { kind: 'executor', entry: 'src/lib/ui/PickerPanel.svelte', cssClass: 'piui-picker', search: 'Search teammates, harnesses and pipelines' },
  { kind: 'model', entry: 'src/app/shell/ModelPickerPanel.svelte', cssClass: 'piui-models', search: 'Search models' },
] as const;

// Read inside each test: the production server builds its assets before tests run.
function manifest(): BuildManifest {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'dist', '.vite', 'manifest.json'), 'utf8')) as BuildManifest;
}

function stylesInStaticGraph(build: BuildManifest, entry: string): Set<string> {
  const styles = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = build[key];
    if (!chunk) throw new Error(`Missing build graph entry: ${key}`);
    for (const css of chunk.css ?? []) styles.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit(entry);
  return styles;
}

test('both deferred picker closures use only styles present in the initial asset graph', () => {
  const build = manifest();
  const initial = stylesInStaticGraph(build, 'index.html');
  expect(initial.size).toBeGreaterThan(0);
  for (const panel of panels) {
    const extra = [...stylesInStaticGraph(build, panel.entry)].filter((css) => !initial.has(css));
    expect(extra, `${panel.kind} must not depend on a separately fetched stylesheet`).toEqual([]);
  }
});

declare global {
  interface Window { __pickerCspViolations?: string[] }
}

test.describe('production picker recovery', () => {
  test.use({ allowConsoleErrors: true });
  for (const panel of panels) {
    test(`${panel.kind} retries its production JavaScript and keeps styles, keyboard focus and draft`, async ({ lab, page }) => {
      await page.addInitScript(() => {
        window.__pickerCspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          window.__pickerCspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`);
        });
      });
      const asset = manifest()[panel.entry]!.file;
      let requests = 0;
      await page.route(`**/${asset}`, async (route) => {
        requests += 1;
        if (requests === 1) await route.abort('failed');
        else await route.continue();
      });
      await lab.open();
      const home = page.getByRole('region', { name: 'What should we work on?' });
      if (panel.kind === 'model') {
        await home.getByRole('button', { name: 'Pi', exact: true }).click();
        await lab.option(/^Codex/).click();
      }
      const draft = `Draft survives the ${panel.kind} production module failure`;
      await home.getByRole('textbox', { name: 'Message' }).fill(draft);
      const trigger = panel.kind === 'model'
        ? home.getByRole('button', { name: /^(Default model|Choose a model)$/ })
        : home.getByRole('button', { name: 'Pi', exact: true });
      expect(requests).toBe(0);
      await trigger.press('Enter');
      await expect(page.getByText('This view could not be loaded', { exact: true })).toBeVisible();
      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeFocused();
      await retry.press('Enter');
      await expect(page.getByPlaceholder(panel.search)).toBeFocused();
      expect(requests).toBe(2);

      // These are the existing panel CSS contracts that disappeared after a failed CSS preload.
      const popup = page.locator(`.${panel.cssClass}`);
      const list = popup.locator(`.${panel.cssClass}__list`);
      await expect(popup).toHaveCSS('display', 'flex');
      await expect(popup).toHaveCSS('border-top-style', 'solid');
      await expect(list).toHaveCSS('overflow-y', 'auto');
      await expect(popup.locator(`.${panel.cssClass}__search`)).toHaveCSS('display', 'flex');
      if (panel.kind === 'model') {
        await lab.option(/^GPT Lab 5 Codex/).click();
        const reasoning = popup.getByRole('radiogroup', { name: 'Reasoning', exact: true });
        await expect(reasoning).toBeVisible();
        await expect(reasoning).toHaveCSS('display', 'flex');
        await expect(reasoning).toHaveCSS('height', '32px');
      }
      await page.keyboard.press('Escape');
      await expect(home.getByRole('textbox', { name: 'Message' })).toHaveValue(draft);
      expect(await page.evaluate(() => window.__pickerCspViolations ?? [])).toEqual([]);
      expect(lab.errors.filter((message) => !message.includes('Failed to load resource'))).toEqual([]);
    });
  }
});
