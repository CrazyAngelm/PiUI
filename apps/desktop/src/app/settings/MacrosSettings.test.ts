import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { createRawSnippet, getAllContexts } from 'svelte';
import { Tooltip } from 'bits-ui';
import MacrosSettings from './MacrosSettings.svelte';
import { macros } from '../macros/macros.svelte';

function html(): string {
  const children = createRawSnippet(() => ({
    render: () => `<div>${render(MacrosSettings, { context: getAllContexts() }).body}</div>`,
  }));
  return render(Tooltip.Provider, { props: { children } }).body;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  macros.list = [];
  macros.sessionOnly = false;
});
afterEach(() => { macros.list = []; macros.sessionOnly = false; vi.unstubAllGlobals(); });

it('explains the empty list and offers a new macro', () => {
  const body = html();
  expect(body).toContain('No macros yet');
  expect(body).toContain('A macro is a saved prompt or a set of skills. Press Space in an empty message, or Space twice after text, to add one.');
  expect(body).toContain('New macro');
});

it('shows saved rows with summaries and labelled edit and delete controls', () => {
  macros.list = [
    { id: 'review', name: 'review', description: 'Review changes', prompt: '<script>hidden</script>', skills: [] },
    { id: 'test', name: 'test', description: '', prompt: '', skills: ['test-runner'] },
  ];
  const body = html();
  expect(body).toContain('role="list"');
  expect(body.match(/role="listitem"/g)).toHaveLength(2);
  for (const text of ['//review', 'Review changes', 'test-runner', 'Edit //review', 'Delete //review']) expect(body).toContain(text);
  expect(body).not.toContain('No macros yet');
  expect(body).not.toContain('<script>hidden');
});

it('reports when edits only last for this session', () => {
  macros.sessionOnly = true;
  const body = html();
  expect(body).toContain('role="alert"');
  expect(body).toContain('Macros could not be saved on this device. They last until the app closes.');
});
