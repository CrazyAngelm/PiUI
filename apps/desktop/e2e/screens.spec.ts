import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { SCREENS } from './screens';

/**
 * Every main screen in light and dark:
 * - an axe-core audit: serious and critical WCAG 2.1 A/AA violations fail;
 *   every violation (minor and moderate too) is attached to the report;
 * - a screenshot in test-results/screenshots/ (git-ignored, not compared).
 */
const BLOCKING = new Set(['serious', 'critical']);
const SCREENSHOTS = join(import.meta.dirname, '..', 'test-results', 'screenshots');

/**
 * Known, reviewed exceptions: one rule on one kind of element each, with the
 * reason. Keep this short; anything else serious or critical fails the test.
 */
const KNOWN: readonly { rule: string; html: RegExp; reason: string }[] = [
  {
    // bits-ui Command points the combobox's aria-controls at its viewport, not
    // at the listbox, so axe cannot tell the list is the combobox popup. The
    // options are reached from the search field (arrows + aria-activedescendant).
    rule: 'scrollable-region-focusable',
    html: /^<div [^>]*data-command-list=""/,
    reason: 'bits-ui command listbox is operated from its combobox',
  },
];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`main screens (${theme})`, () => {
    test.use({ colorScheme: theme, reducedMotion: 'reduce' });

    for (const screen of SCREENS) {
      test(`${screen.name}: no serious axe violations, screenshot`, async ({ lab, page }, testInfo) => {
        test.slow(); // axe's contrast pass is CPU-heavy on the canvas screens.
        await lab.open();
        await screen.open(lab);
        await page.screenshot({ path: join(SCREENSHOTS, `${screen.name}-${theme}.png`), animations: 'disabled', caret: 'hide' });

        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const summary = results.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.map((node) => ({ target: node.target.join(' '), html: node.html.slice(0, 160) })),
        }));
        if (summary.length) {
          await testInfo.attach(`axe-${screen.name}-${theme}.json`, { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
        }
        const blocking = summary
          .filter((violation) => BLOCKING.has(violation.impact ?? ''))
          .map((violation) => ({
            ...violation,
            nodes: violation.nodes.filter((node) => !KNOWN.some((known) => known.rule === violation.id && known.html.test(node.html))),
          }))
          .filter((violation) => violation.nodes.length > 0);
        expect(blocking, `${screen.name} (${theme})`).toEqual([]);
      });
    }
  });
}
