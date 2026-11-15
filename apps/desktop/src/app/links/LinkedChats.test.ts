import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { sessionLinksHost, type LinkedChatV1 } from '../../host-api/sessionLinksClient';
import { WORKSPACE_CONTEXT } from '../shell/context';
import LinkedChats from './LinkedChats.svelte';
import { sessionLinks } from './sessionLinks.svelte';

const chat = (patch: Partial<LinkedChatV1>): LinkedChatV1 => ({ sessionId: 'x', title: 'Chat', harness: 'codex', kind: 'agent', relation: 'child', state: 'idle', pending: 0, ...patch });

type Catalog = { id: string; title: string; status: string }[];

async function html(sessionId: string, chats: LinkedChatV1[], harness: 'pi' | 'codex' = 'codex', safeMode = false, sessions: Catalog = []): Promise<string> {
  vi.spyOn(sessionLinksHost, 'onChanged').mockResolvedValue(() => undefined);
  vi.spyOn(sessionLinksHost, 'request').mockResolvedValue({ type: 'links', sessionId, chats, revision: 1 });
  await sessionLinks.load(sessionId);
  return render(LinkedChats, {
    props: { sessionId, harness, notices: [] },
    context: new Map([[WORKSPACE_CONTEXT, { safeMode, catalog: { sessions }, openSession: () => undefined }]]),
  }).body;
}

afterEach(() => vi.restoreAllMocks());

describe('linked chats section of the chat details', () => {
  it('shows nothing for a chat without links', async () => {
    expect((await html('none', [])).replace(/<!--.*?-->/g, '')).toBe('');
  });

  it('lists a row per chat with the title, a badge only for starting, running and failed, and the report', async () => {
    const body = await html('lead', [
      chat({ sessionId: 'a', title: 'Review parser', state: 'running', lastReport: { at: '2026-11-16T10:00:00Z', excerpt: 'Found two issues.' } }),
      chat({ sessionId: 'b', title: 'Idle helper', state: 'idle' }),
      chat({ sessionId: 'c', title: 'Closed helper', state: 'closed' }),
      chat({ sessionId: 'd', title: 'Broken helper', state: 'failed' }),
    ]);
    expect(body).toContain('Linked chats');
    for (const title of ['Review parser', 'Idle helper', 'Closed helper', 'Broken helper']) expect(body).toContain(title);
    expect(body).toContain('Found two issues.');
    expect(body.match(/badge badge--/g)).toHaveLength(2);
    expect(body).toContain('Running');
    expect(body).toContain('Failed');
    expect(body).not.toContain('Deliver');
    expect(body).not.toContain('cannot use linked chats');
  });

  it('shows the state and title the catalog has now, and the cached ones for a chat it does not list', async () => {
    const body = await html(
      'lead4',
      [
        chat({ sessionId: 'a', title: 'Old name', state: 'running' }),
        chat({ sessionId: 'b', title: 'Helper', state: 'idle' }),
        chat({ sessionId: 'c', title: 'Not in catalog', state: 'failed' }),
      ],
      'codex',
      false,
      [
        { id: 'a', title: 'Renamed review', status: 'idle' },
        { id: 'b', title: 'Helper', status: 'failed' },
      ],
    );
    expect(body).toContain('Renamed review');
    expect(body).not.toContain('Old name');
    expect(body).toContain('Not in catalog');
    expect(body).not.toContain('Running');
    expect(body.match(/Failed/g)).toHaveLength(2);
  });

  it('offers Deliver with the pending count, disabled in safe mode', async () => {
    const waiting = [chat({ sessionId: 'a', title: 'Helper', pending: 3 })];
    const deliverTag = (body: string): string => body.match(/<button[^>]*btn[^>]*>(?=(?:(?!<\/button>)[\s\S])*Deliver)/)?.[0] ?? '';
    const body = await html('lead2', waiting);
    expect(body).toContain('3 waiting');
    expect(deliverTag(body)).not.toBe('');
    expect(deliverTag(body)).not.toContain('disabled');
    expect(deliverTag(await html('lead3', waiting, 'codex', true))).toContain('disabled');
  });

  it('says once that the agent of this chat cannot use linked chats', async () => {
    const body = await html('pi-chat', [chat({ sessionId: 'a', title: 'Helper' })], 'pi');
    expect(body.match(/The agent in this chat cannot use linked chats\./g)).toHaveLength(1);
  });
});
