import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../../features/locale/ruCatalog';
import { NANO_REMOTE_ERROR_COPY } from '../../host-api/nanoRemoteClient';
import { REMOTE_UNAVAILABLE_COPY } from './remoteMode';

const here = dirname(fileURLToPath(import.meta.url));
/** The remote access screens: every `$t('…')` literal must have a Russian entry. */
const FILES = ['../settings/RemoteAccessSettings.svelte', 'RemotePairingDialog.svelte', 'RemoteViewerIndicator.svelte'];
/** Copy kept in tables that reaches `$t` later. */
const MESSAGES = [
  ...Object.values(NANO_REMOTE_ERROR_COPY),
  REMOTE_UNAVAILABLE_COPY,
  'Not available in safe mode.',
  'Sign in to use remote access.',
  'This Nano server does not support remote access yet.',
];

const source = (file: string): string => readFileSync(join(here, file), 'utf8');
function literals(file: string): string[] {
  return [...source(file).matchAll(/\$t\('((?:[^'\\]|\\.)*)'/gu)].map((match) => (match[1] ?? '').replace(/\\'/gu, "'"));
}

describe('remote access in Russian', () => {
  it('translates every visible string', () => {
    const copy = [...new Set([...FILES.flatMap(literals), ...MESSAGES])];
    expect(copy.length).toBeGreaterThan(20);
    expect(copy.filter((value) => lookupRussian(value) === undefined)).toEqual([]);
  });
});

describe('the pairing prompt', () => {
  const dialog = source('RemotePairingDialog.svelte');

  it('asks for an explicit choice: no close button, and Escape is the same as Deny', () => {
    expect(dialog).toContain('dismissible={false}');
    expect(dialog).toMatch(/event\.key !== 'Escape'/u);
    expect(dialog).toMatch(/decide\('deny'\);\s*\}\s*<\/script>/u);
  });

  it('offers Deny first, then Allow once, then Always allow this browser', () => {
    const order = ["$t('Deny')", "$t('Allow once')", "$t('Always allow this browser')"].map((text) => dialog.indexOf(text));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(dialog).toContain('bind:ref={deny}');
  });

  it('shows the code grouped and reads it digit by digit', () => {
    expect(dialog).toContain('pending.code.slice(0, 3)');
    expect(dialog).toContain("pending.code.split('').join(' ')");
    expect(dialog).toContain("$t('Code {0}', [spoken])");
  });

  it('is loaded on demand, never at first paint', () => {
    const shell = source('../shell/AppShell.svelte');
    const sidebar = source('../shell/Sidebar.svelte');
    const holder = source('./remoteShell.svelte.ts');
    const controller = source('./RemoteController.svelte');
    for (const file of [shell, sidebar]) {
      expect(file).not.toMatch(/^\s*import .*(RemotePairingDialog|RemoteViewerIndicator|RemoteController|nanoRemote\.svelte)/mu);
    }
    expect(holder).toContain("import('./RemoteController.svelte')");
    expect(holder).toContain("import('./RemoteViewerIndicator.svelte')");
    expect(controller).toContain("import('./RemotePairingDialog.svelte')");
    expect(controller).not.toMatch(/^\s*import RemotePairingDialog/mu);
  });
});
