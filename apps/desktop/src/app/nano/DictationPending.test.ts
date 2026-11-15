import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import DictationPending from './DictationPending.svelte';
import { PendingRecordings, type PendingReason } from './dictationPendingStore.svelte';
import { DictationSource } from './dictationSource.svelte';

const SCOPE = 'chat:session-1';

async function html(reason: PendingReason | undefined, scope = SCOPE): Promise<string> {
  const pending = new PendingRecordings(undefined, () => 2);
  if (reason !== undefined) {
    await pending.put({ id: 'a', scope: SCOPE, blob: new Blob([new Uint8Array(3)]), mimeType: 'audio/webm', durationMs: 102_000, createdAt: 1, reason });
  }
  const source = new DictationSource({ settings: async () => { throw new Error('not read'); } }, { canDictate: true, dictationMaxBytes: 5_000_000 });
  return render(DictationPending, { props: { scope, onText: () => undefined, source, pending } }).body;
}

describe('the unsent recording bar', () => {
  it('shows nothing when no recording waits in its scope', async () => {
    expect(await html(undefined)).not.toContain('Retry');
    expect(await html('failed', 'new:personal')).not.toContain('Retry');
  });

  it('names the recording and offers retry, save and delete as labelled buttons', async () => {
    const body = await html('failed');
    expect(body).toContain('role="group"');
    expect(body).toContain('aria-label="Unsent recording"');
    expect(body).toContain('Recording 1:42 was not transcribed');
    for (const action of ['Retry', 'Save audio', 'Delete']) expect(body).toContain(action);
    expect(body.match(/<button/g)).toHaveLength(3);
  });

  it('says what happened to the recording', async () => {
    expect(await html('empty')).toContain('Recording 1:42 was not transcribed');
    expect(await html('unsent')).toContain('Recording 1:42 was not sent');
    expect(await html('too-large')).toContain('Recording 1:42 was too large to send');
  });

  it('says when the clip is kept only until the app closes', async () => {
    expect(await html('failed')).toContain('Kept only until the app closes');
  });

  it('does not offer a clip that a window is still recording or sending', async () => {
    const pending = new PendingRecordings(undefined, () => 2);
    await pending.put({ id: 'a', scope: SCOPE, blob: new Blob([new Uint8Array(3)]), mimeType: 'audio/webm', durationMs: 1, createdAt: 1, reason: 'unsent' });
    pending.hold('a');
    const source = new DictationSource({ settings: async () => { throw new Error('not read'); } }, { canDictate: true, dictationMaxBytes: 5_000_000 });
    expect(render(DictationPending, { props: { scope: SCOPE, onText: () => undefined, source, pending } }).body).not.toContain('Retry');
    pending.release('a');
    expect(render(DictationPending, { props: { scope: SCOPE, onText: () => undefined, source, pending } }).body).toContain('Retry');
  });
});
