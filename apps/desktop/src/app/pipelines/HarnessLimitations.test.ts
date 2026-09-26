import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Harness } from '../../../../../contracts/orchestration-v6';
import { harnessConfigurations } from '../../harness-adapters';
import type { HarnessConfiguration } from '../../harness-adapters/types';
import HarnessLimitations from './HarnessLimitations.svelte';

const html = (harness: Harness): string =>
  render(HarnessLimitations, { props: { harness } }).body.replace(/<!--[\s\S]*?-->/g, '');

describe('HarnessLimitations', () => {
  it('lists the manifest limitations of every harness in a collapsed, keyboard-operable disclosure', () => {
    for (const [harness, configuration] of Object.entries(harnessConfigurations) as [Harness, HarnessConfiguration][]) {
      const limitations = configuration.limitations ?? [];
      expect(limitations.length, harness).toBeGreaterThan(0);
      const body = html(harness);
      // A native <details>/<summary> is focusable and toggles with Enter or Space.
      expect(body).toMatch(/<details class="limits[^"]*">/);
      expect(body).not.toMatch(/<details[^>]*\bopen\b/);
      expect(body).toMatch(new RegExp(`<summary[^>]*>[\\s\\S]*Limitations of ${configuration.name}[\\s\\S]*${limitations.length}[\\s\\S]*</summary>`));
      for (const limitation of limitations) {
        const escaped = limitation.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        expect(body, `${harness}: ${limitation}`).toContain(`<li>${escaped}</li>`);
      }
    }
  });
});
