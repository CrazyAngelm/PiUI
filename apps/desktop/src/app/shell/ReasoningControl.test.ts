import type { ComponentProps } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { language } from '../../features/locale/language';
import { lookupRussian } from '../../features/locale/ruCatalog';
import ReasoningControl from './ReasoningControl.svelte';

const CODEX = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function body(props: ComponentProps<typeof ReasoningControl> = {}): string {
  return render(ReasoningControl, { props }).body;
}

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function attribute(tag: string, name: string): string | undefined {
  for (const [, key, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) if (key === name) return value;
  return undefined;
}

/** A bare boolean attribute such as `disabled`, which is not `aria-disabled`. */
const flagged = (tag: string, name: string): boolean => tag.split(/\s+/).some((part) => part === name || part.startsWith(`${name}=`));

function tagWithRole(markup: string, role: string): string {
  for (const [, tag = ''] of markup.matchAll(/<(?:div|button)\b([^>]*)>/g)) if (attribute(tag, 'role') === role) return tag;
  throw new Error(`Nothing with role ${role} was rendered.`);
}

interface Radio {
  name: string;
  checked: string | undefined;
  tabindex: string | undefined;
  blocked: string | undefined;
  nativelyDisabled: boolean;
  title: string | undefined;
  rise: string | undefined;
}

function radios(markup: string): Radio[] {
  const found: Radio[] = [];
  for (const [, tag = '', inner = ''] of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (attribute(tag, 'role') !== 'radio') continue;
    found.push({
      name: text(inner),
      checked: attribute(tag, 'aria-checked'),
      tabindex: attribute(tag, 'tabindex'),
      blocked: attribute(tag, 'aria-disabled'),
      nativelyDisabled: flagged(tag, 'disabled'),
      title: attribute(tag, 'title'),
      rise: /--rise:\s*([\d.]+)/.exec(attribute(tag, 'style') ?? '')?.[1],
    });
  }
  return found;
}

function readout(markup: string): string | undefined {
  for (const [, tag = '', inner = ''] of markup.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)) {
    if (attribute(tag, 'aria-hidden') === 'true' && (attribute(tag, 'class') ?? '').split(' ').includes('readout')) return text(inner);
  }
  return undefined;
}

describe('ReasoningControl', () => {
  it('is a radiogroup named Reasoning with one radio per level, Auto first', () => {
    const markup = body({ levels: CODEX, level: 'high', levelDefault: true });
    expect(attribute(tagWithRole(markup, 'radiogroup'), 'aria-label')).toBe('Reasoning');
    expect(radios(markup).map((radio) => radio.name)).toEqual(['Auto', ...CODEX]);
    expect(radios(body({ levels: CODEX, level: 'high' })).map((radio) => radio.name)).toEqual(CODEX);
  });

  it('checks only the selected level and keeps the one tab stop on it', () => {
    const list = radios(body({ levels: CODEX, level: 'high', levelDefault: true }));
    expect(list.map((radio) => radio.checked)).toEqual(['false', 'false', 'false', 'false', 'false', 'true', 'false']);
    expect(list.map((radio) => radio.tabindex)).toEqual(['-1', '-1', '-1', '-1', '-1', '0', '-1']);
  });

  it('checks Auto for the native default', () => {
    const list = radios(body({ levels: CODEX, level: '', levelDefault: true }));
    expect(list.map((radio) => radio.checked)).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
    expect(list.map((radio) => radio.tabindex)).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1']);
  });

  it('keeps the first radio reachable when nothing is selected', () => {
    const markup = body({ levels: ['low', 'medium', 'high'], level: '' });
    const list = radios(markup);
    expect(list.map((radio) => radio.checked)).toEqual(['false', 'false', 'false']);
    expect(list.map((radio) => radio.tabindex)).toEqual(['0', '-1', '-1']);
    expect(readout(markup)).toBe('Native default');
    // A level the model no longer offers is not a selection either.
    expect(readout(body({ levels: ['low', 'medium', 'high'], level: 'max' }))).toBe('Native default');
  });

  it('names the selection in one readout that assistive technology skips', () => {
    expect(readout(body({ levels: CODEX, level: 'xhigh', levelDefault: true }))).toBe('xhigh');
    expect(readout(body({ levels: CODEX, level: '', levelDefault: true }))).toBe('Auto');
  });

  it('gives every bar a tooltip and leaves the visible Auto label without one', () => {
    const list = radios(body({ levels: CODEX, level: 'low', levelDefault: true }));
    expect(list.map((radio) => radio.title)).toEqual([undefined, ...CODEX]);
  });

  it('raises the bars from the lowest level to the highest and keeps a zero level flat', () => {
    const list = radios(body({ levels: CODEX, level: 'low', levelDefault: true }));
    expect(list.map((radio) => radio.rise)).toEqual([undefined, undefined, '0', '0.25', '0.5', '0.75', '1']);
  });

  it('names the levels in the interface language', () => {
    const expected = ['Auto', ...CODEX].map((source) => lookupRussian(source));
    expect(expected.every(Boolean)).toBe(true);
    language.set('ru');
    try {
      const markup = body({ levels: CODEX, level: 'high', levelDefault: true });
      expect(radios(markup).map((radio) => radio.name)).toEqual(expected);
      expect(readout(markup)).toBe(lookupRussian('high'));
    } finally {
      language.set('en');
    }
  });

  it('blocks the radios while busy without taking them out of the tab order', () => {
    const markup = body({ levels: CODEX, level: 'medium', levelDefault: true, fastAvailable: true, busy: true });
    const list = radios(markup);
    expect(list.every((radio) => radio.blocked === 'true')).toBe(true);
    expect(list.some((radio) => radio.nativelyDisabled)).toBe(false);
    expect(list.filter((radio) => radio.tabindex === '0').map((radio) => radio.name)).toEqual(['medium']);
    expect(flagged(tagWithRole(markup, 'switch'), 'disabled')).toBe(true);

    const idle = body({ levels: CODEX, level: 'medium', levelDefault: true, fastAvailable: true });
    expect(radios(idle).every((radio) => radio.blocked === undefined)).toBe(true);
    expect(flagged(tagWithRole(idle, 'switch'), 'disabled')).toBe(false);
  });

  it('offers Fast mode as a named switch that its visible label toggles', () => {
    const on = body({ fastAvailable: true, fast: true });
    const toggle = tagWithRole(on, 'switch');
    expect(attribute(toggle, 'aria-label')).toBe('Fast mode');
    expect(attribute(toggle, 'aria-checked')).toBe('true');
    expect(attribute(toggle, 'id')).toBeTruthy();
    expect(on).toContain(`for="${attribute(toggle, 'id')}"`);
    expect(attribute(tagWithRole(body({ fastAvailable: true }), 'switch'), 'aria-checked')).toBe('false');
  });

  it('renders only what the model offers', () => {
    expect(bare(body()).trim()).toBe('');
    // Auto alone is not a choice.
    expect(bare(body({ levelDefault: true })).trim()).toBe('');
    const fastOnly = body({ fastAvailable: true });
    expect(fastOnly).not.toContain('role="radiogroup"');
    expect(fastOnly).toContain('role="switch"');
    const levelsOnly = body({ levels: ['low', 'high'], level: 'low' });
    expect(levelsOnly).toContain('role="radiogroup"');
    expect(levelsOnly).not.toContain('role="switch"');
  });
});
