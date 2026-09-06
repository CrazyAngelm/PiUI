import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { readFileSync } from 'node:fs';
import WorkspaceShell from './WorkspaceShell.svelte';

describe('WorkspaceShell visible primary actions', () => {
  it('renders New chat as visible button content rather than only an accessible name or shortcut', () => {
    const { body } = render(WorkspaceShell);
    expect(body).toMatch(/<button[^>]*class="[^"]*accent[^"]*"[^>]*>[\s\S]*?<span>New chat<\/span>/);
    expect(body).toMatch(/aria-hidden="true">＋<\/span>/);
    expect(body).toMatch(/<kbd[^>]*>Ctrl\+N<\/kbd>/);
    expect(body).not.toContain('aria-label="New chat"');
    expect(body).not.toContain('Legacy history');
    expect(body).not.toContain('<span>Approvals</span>');
    expect(body).not.toContain('<span>Activity</span>');
    const source = readFileSync(new URL('./WorkspaceShell.svelte', import.meta.url), 'utf8');
    expect(source).toContain('background:var(--piui-accent); color:var(--piui-accent-ink)');
    expect(source).not.toContain('--workspace-action-ink');
    expect(source).not.toContain('button.accent kbd { color:currentColor; opacity:');
  });
});
