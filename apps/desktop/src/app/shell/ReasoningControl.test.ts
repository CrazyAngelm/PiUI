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
  pos: string | undefined;
  classes: string[];
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
      pos: /--pos:\s*([\d.]+)/.exec(attribute(tag, 'style') ?? '')?.[1],
      classes: (attribute(tag, 'class') ?? '').split(/\s+/),
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

/** A custom property the radiogroup sets for the track, the fill and the thumbs. */
function gauge(markup: string, name: 'count' | 'at' | 'peek' | 'fill'): string | undefined {
  return new RegExp(`--${name}:\\s*([\\d.]+)`).exec(attribute(tagWithRole(markup, 'radiogroup'), 'style') ?? '')?.[1];
}

/** Whether the thumb (or the ghost thumb) is hidden. */
function thumbHidden(markup: string, ghost: boolean): boolean {
  for (const [, tag = ''] of markup.matchAll(/<span\b([^>]*)>/g)) {
    const classes = (attribute(tag, 'class') ?? '').split(/\s+/);
    if (classes.includes('thumb') && classes.includes('thumb--ghost') === ghost) return classes.includes('thumb--off');
  }
  throw new Error('No thumb was rendered.');
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

  it('gives every stop a tooltip, Auto included', () => {
    const list = radios(body({ levels: CODEX, level: 'low', levelDefault: true }));
    expect(list.map((radio) => radio.title)).toEqual(['Auto', ...CODEX]);
  });

  it('spreads the stops along the rail and keeps Auto beside it', () => {
    const markup = body({ levels: CODEX, level: 'low', levelDefault: true });
    expect(radios(markup).map((radio) => radio.pos)).toEqual([undefined, '0', '0.2', '0.4', '0.6', '0.8', '1']);
    expect(gauge(markup, 'count')).toBe('6');
    expect((attribute(tagWithRole(markup, 'radiogroup'), 'class') ?? '').split(/\s+/)).toContain('gauge--auto');
    const plain = body({ levels: CODEX, level: 'low' });
    expect((attribute(tagWithRole(plain, 'radiogroup'), 'class') ?? '').split(/\s+/)).not.toContain('gauge--auto');
  });

  it('puts the thumb on the selected stop and fills the rail up to it', () => {
    const high = body({ levels: CODEX, level: 'high', levelDefault: true });
    expect([gauge(high, 'at'), gauge(high, 'fill')]).toEqual(['4', '0.8']);
    expect(thumbHidden(high, false)).toBe(false);
    expect(thumbHidden(high, true)).toBe(true);
    expect(radios(high).map((radio) => radio.classes.includes('stop--lit'))).toEqual([false, true, true, true, true, true, false]);

    // The first stop holds the thumb and fills nothing.
    const none = body({ levels: CODEX, level: 'none', levelDefault: true });
    expect([gauge(none, 'at'), gauge(none, 'fill')]).toEqual(['0', '0']);
    expect(thumbHidden(none, false)).toBe(false);
  });

  it('empties the rail and hides the thumb for Auto and for no selection', () => {
    const auto = body({ levels: CODEX, level: '', levelDefault: true });
    expect(gauge(auto, 'fill')).toBe('0');
    expect(thumbHidden(auto, false)).toBe(true);
    expect(radios(auto).some((radio) => radio.classes.includes('stop--lit'))).toBe(false);
    expect(thumbHidden(body({ levels: ['low', 'medium', 'high'], level: 'max' }), false)).toBe(true);
  });

  it('draws Auto as the dock and a zero level as a hollow stop', () => {
    const list = radios(body({ levels: CODEX, level: 'low', levelDefault: true }));
    expect(list.map((radio) => radio.classes.includes('stop--auto'))).toEqual([true, false, false, false, false, false, false]);
    expect(list.map((radio) => radio.classes.includes('stop--zero'))).toEqual([false, true, false, false, false, false, false]);
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
