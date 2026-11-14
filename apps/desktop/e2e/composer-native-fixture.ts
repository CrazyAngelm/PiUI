import { mount, unmount, tick } from 'svelte';
import NativeComposerFixture from './NativeComposerFixture.svelte';
import type { SessionSnapshot } from '../src/host-api/workspaceClient';

// Like the transcript fixture, this mounts the actual native component with a
// synthetic presentation owner. The real host transport remains untouched and
// refuses this deliberately nonexistent session; no agent or provider starts.
let root: HTMLDivElement | undefined;
let component: ReturnType<typeof mount> | undefined;
let draft = '';
const sessionId = '00000000-0000-4000-8000-000000000008';

export async function beginComposerProof() {
  if (root) throw new Error('The native composer fixture is already mounted.');
  root = document.createElement('div');
  root.dataset.composerProof = 'synthetic';
  root.style.cssText = 'position:fixed;inset:16px;z-index:10000;background:var(--piui-bg);padding:16px;display:flex;flex-direction:column;justify-content:end';
  document.body.append(root);
  const unsupported = { supported: false, enforcement: 'unsupported' as const };
  const snapshot: SessionSnapshot = {
    session: { id: sessionId, workspaceId: 'synthetic-composer-workspace', harness: 'codex', title: 'Synthetic composer owner', status: 'idle', updatedAt: '2026-11-14T00:00:00Z' },
    revision: 0, blocks: [], approvals: [], models: [],
    capabilities: { prompt: { supported: true, enforcement: 'native' }, resume: unsupported, models: unsupported, approvals: unsupported, instructions: unsupported, toolPolicy: unsupported, nativeSubagents: unsupported },
  };
  draft = '';
  component = mount(NativeComposerFixture, { target: root, props: { snapshot, updateDraft: (value: string) => { draft = value; } } });
  await tick();
  return composerProofState();
}

export async function composerProofState() {
  await tick();
  const input = root?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  return {
    sessionId, draft, value: input?.value, shared: input?.dataset.nanoComposer,
    error: root?.querySelector('[role="alert"]')?.textContent?.trim() ?? '',
    sendDisabled: root?.querySelector<HTMLButtonElement>('[data-nano-composer="send"]')?.disabled,
    modelDisabled: [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.textContent?.trim() === 'Default model')?.disabled,
  };
}

export async function endComposerProof() {
  try { if (component) await unmount(component); }
  finally { root?.remove(); root = undefined; component = undefined; }
  return !document.querySelector('[data-composer-proof]');
}
