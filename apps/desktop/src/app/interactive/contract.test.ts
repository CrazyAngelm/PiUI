import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeTypes, unsupportedNodeTypes } from './renderer.js';

const instruction = readFileSync(new URL('../../../src-tauri/src/interactive_answers_instruction.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
const supported = ['row', 'column', 'grid', 'card', 'tabs', 'details', 'divider', 'heading', 'text', 'callout', 'badge', 'badges', 'list', 'kv', 'stat', 'progress', 'steps', 'link', 'table', 'chart', 'slider', 'number', 'input', 'date', 'select', 'segmented', 'toggle', 'checklist', 'range', 'button', 'buttons', 'choices', 'each'];

describe('interactive answers desktop contract', () => {
  it.each(supported)('implements and advertises %s', name => {
    expect(nodeTypes).toContain(name);
    expect(instruction).toContain(`${name} {`);
  });

  it.each(unsupportedNodeTypes)('keeps %s out of the instruction', name => {
    expect(instruction).not.toContain(`${name} {`);
  });

  it('freezes the advertised type lists', () => {
    expect(Object.isFrozen(nodeTypes)).toBe(true);
    expect(Object.isFrozen(unsupportedNodeTypes)).toBe(true);
  });

  it.each([
    'createElement("a"', "createElement('a'", 'el("a"', "el('a'", 'iframe', '.href =', '.src =', 'srcdoc',
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'fetch(', 'addEventListener("message"',
  ])('does not contain the forbidden primitive %s', primitive => {
    expect(source).not.toContain(primitive);
  });
});
