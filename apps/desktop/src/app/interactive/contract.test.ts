import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTERACTIVE_APP_TARGETS } from './decorate';
import { appActionTargets, nodeTypes, unsupportedNodeTypes } from './renderer.js';

const instruction = readFileSync(new URL('../../../src-tauri/src/interactive_answers_instruction.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
const supported = ['row', 'column', 'grid', 'card', 'tabs', 'details', 'divider', 'heading', 'text', 'callout', 'badge', 'badges', 'list', 'kv', 'stat', 'progress', 'steps', 'formula', 'link', 'image', 'gallery', 'video', 'audio', 'region', 'table', 'chart', 'slider', 'number', 'input', 'date', 'select', 'segmented', 'toggle', 'checklist', 'range', 'button', 'buttons', 'choices', 'each'];

describe('interactive answers desktop contract', () => {
  it.each(supported)('implements and advertises %s', name => {
    expect(nodeTypes).toContain(name);
    expect(instruction).toContain(`${name} {`);
  });

  it.each(unsupportedNodeTypes)('keeps %s out of the instruction (it shows a note, ADR-077)', name => {
    expect(nodeTypes).toContain(name);
    expect(instruction).not.toContain(`${name} {`);
  });

  it('advertises exactly the application actions the renderer and the decoration implement', () => {
    expect([...INTERACTIVE_APP_TARGETS]).toEqual([...appActionTargets]);
    for (const target of appActionTargets) expect(instruction).toContain(target);
    for (const webOnly of ['connect_telegram', 'open_goals', 'connect_google', 'open_payments', 'enable_brief']) {
      expect(instruction).not.toContain(webOnly);
    }
  });

  it('advertises no media source the app cannot load', () => {
    expect(instruction).not.toMatch(/\{(?:file \| )?src|"src"\s*\|/);
    expect(instruction).toContain('loads nothing from the network');
    expect(instruction).not.toContain('poster');
    expect(instruction).not.toContain('cdn.');
  });

  it('freezes the advertised type lists', () => {
    expect(Object.isFrozen(nodeTypes)).toBe(true);
    expect(Object.isFrozen(unsupportedNodeTypes)).toBe(true);
    expect(Object.isFrozen(appActionTargets)).toBe(true);
  });

  it.each([
    'createElement("a"', "createElement('a'", 'el("a"', "el('a'", 'iframe', 'srcdoc', 'srcDoc',
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket',
    'addEventListener("message"', 'window.open', 'location.', 'embedUrl',
  ])('does not contain the forbidden primitive %s', primitive => {
    expect(source).not.toContain(primitive);
  });

  it('never assigns an address to an element property', () => {
    expect(source).not.toMatch(/\.(?:src|href|srcdoc|action|poster|data)\s*=(?!=)/);
  });

  it('lets a media element receive an address from one guarded place only (a host blob: URL)', () => {
    const sets = [...source.matchAll(/setAttribute\("(?:src|href|poster|data)"/g)];
    expect(sets).toHaveLength(1);
    const guarded = /if \(!url\.startsWith\("blob:"\)\) \{\s*return;\s*\}\s*if \(media\.getAttribute\("src"\) !== url\) \{\s*media\.setAttribute\("src", url\);/;
    expect(source).toMatch(guarded);
  });

  it('opens a link only through the host and only for an https address', () => {
    expect(source).toMatch(/parsed\.protocol === "https:"/);
    expect(source).not.toMatch(/protocol === "http:"|"mailto:"|"tel:"|"javascript:"|"data:"/);
  });
});
