import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LINKS_EVENT_V1, type SessionLinksCommandV1, type SessionLinksResultV1 } from '../../../../../contracts/session-links-v1';
import { LabEventBus } from './labBus';
import { browserTimers, LabClock } from './labClock';
import { createLabSessionLinks, MAX_WAKES } from './sessionLinksFake';
import { LabSessions } from './sessionRuntime';
import { labHost, record } from './labTestKit';
import { demoSessionId } from './scenarios/demoChats';

const parent = demoSessionId('lisbon');
const child = demoSessionId('cache-sizing');
const peer = demoSessionId('transport');
const command = (host: ReturnType<typeof labHost>, request: SessionLinksCommandV1) => host.invoke<SessionLinksResultV1>('session_links_command_v1', { command: request });

describe('linked chats in the UI Lab', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('seeds the first demo chat with an agent child and a report', async () => {
    const host = labHost('demo', { links: 'seed' });
    const links = await command(host, { op: 'find', sessionId: parent });
    expect(links).toMatchObject({ type: 'links', sessionId: parent, chats: [{ sessionId: child, kind: 'agent', relation: 'child', pending: 0, lastReport: { excerpt: expect.any(String) } }] });
    expect(await command(host, { op: 'find', sessionId: child })).toMatchObject({ chats: [{ sessionId: parent, relation: 'parent' }] });
  });

  it('links peers symmetrically, emits revisions for both and unlinks them', async () => {
    const host = labHost('demo', { links: 'seed' });
    const events = await record<{ sessionId: string; revision: number }>(host, SESSION_LINKS_EVENT_V1);
    await vi.advanceTimersByTimeAsync(0);
    events.items.length = 0;
    expect(await command(host, { op: 'link', sessionId: child, otherSessionId: peer })).toEqual({ type: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.items.map(event => event.sessionId)).toEqual([child, peer]);
    expect(await command(host, { op: 'find', sessionId: peer })).toMatchObject({ chats: [{ sessionId: child, kind: 'peer', relation: 'peer' }] });
    await command(host, { op: 'unlink', sessionId: child, otherSessionId: peer });
    expect(await command(host, { op: 'find', sessionId: peer })).toMatchObject({ chats: [] });
    events.stop();
  });

  it('frames a person message, queues for a running target and works when the tool preference is off', async () => {
    const host = labHost('demo', { links: 'seed' });
    await command(host, { op: 'update', enabled: false });
    expect(await command(host, { op: 'settings' })).toEqual({ type: 'settings', enabled: false, readOnly: false });
    await command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: 'Use this estimate.' });
    expect(host.state.sessions.get(child)!.blocks.some(block => block.kind === 'user' && block.text === 'Message from the chat "Plan a weekend in Lisbon", sent by the person:\n\nUse this estimate.')).toBe(true);
    await command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: 'One more detail.' });
    expect(host.state.sessions.get(child)!.live!.pendingPrompts).toContain('Message from the chat "Plan a weekend in Lisbon", sent by the person:\n\nOne more detail.');
  });

  it('retains a person message while its harness is unavailable, then delivers it without changing its origin', async () => {
    const host = labHost('demo', { links: 'seed' });
    host.state.sessions.get(child)!.live = undefined;
    const harnesses = host.state.harnesses;
    host.state.harnesses = harnesses.map(harness => harness.kind === 'pi' ? { ...harness, status: 'unavailable' as const } : harness);
    expect(await command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: 'Keep this message.' })).toEqual({ type: 'done' });
    expect(await command(host, { op: 'find', sessionId: child })).toMatchObject({ chats: [{ pending: 1 }] });
    host.state.harnesses = harnesses;
    await command(host, { op: 'deliver', sessionId: child, fromSessionId: parent });
    expect(await command(host, { op: 'find', sessionId: child })).toMatchObject({ chats: [{ pending: 0 }] });
    expect(host.state.sessions.get(child)!.blocks.some(block => block.text === 'Message from the chat "Plan a weekend in Lisbon", sent by the person:\n\nKeep this message.')).toBe(true);
  });

  it('refuses unlinked targets, invalid text, owned run sessions and unknown fields before delivery', async () => {
    const host = labHost('demo', { links: 'seed' });
    await expect(command(host, { op: 'send', fromSessionId: parent, toSessionId: peer, text: 'Unlinked' })).rejects.toMatchObject({ code: 'unknown-session' });
    await expect(command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: 'x'.repeat(16001) })).rejects.toMatchObject({ code: 'invalid-operation' });
    await expect(command(host, { op: 'link', sessionId: parent, otherSessionId: parent })).rejects.toMatchObject({ code: 'invalid-operation' });
    const run = [...host.state.sessions.values()].find(value => value.runId !== undefined)!;
    await expect(command(host, { op: 'link', sessionId: parent, otherSessionId: run.id })).rejects.toMatchObject({ code: 'not-allowed' });
    await expect(host.invoke('session_links_command_v1', { command: { op: 'settings', extra: true } })).rejects.toBeDefined();
  });

  it('keeps safe-mode links readable while mutations and settings updates are read-only', async () => {
    const host = labHost('safe', { links: 'seed' });
    expect(await command(host, { op: 'settings' })).toEqual({ type: 'settings', enabled: false, readOnly: true });
    expect(await command(host, { op: 'find', sessionId: parent })).toMatchObject({ chats: [{ state: 'closed' }] });
    await expect(command(host, { op: 'update', enabled: true })).rejects.toMatchObject({ code: 'read-only' });
    await expect(command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: 'No send' })).rejects.toMatchObject({ code: 'read-only' });
  });

  it('retains the newest twenty blocked messages after the agent wake limit, then delivers them on a person action', () => {
    const host = labHost('demo', { links: 'seed' });
    const bus = new LabEventBus(browserTimers);
    const runtime = new LabSessions(host.state, bus, new LabClock());
    const links = createLabSessionLinks(runtime, bus, true);
    const recipient = host.state.sessions.get(parent)!;
    for (let wake = 0; wake < MAX_WAKES; wake += 1) {
      links.agentMessage(child, parent, `wake ${wake}`);
      runtime.interrupt(recipient);
    }
    for (let pending = 0; pending < 25; pending += 1) links.agentMessage(child, parent, `pending ${pending}`);
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: parent } })).toMatchObject({ chats: [{ pending: 20 }] });
    links.personMessage(parent);
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: parent } })).toMatchObject({ chats: [{ pending: 20 }] });
    links.handlers.session_links_command_v1!({ command: { op: 'deliver', sessionId: parent, fromSessionId: child } });
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: parent } })).toMatchObject({ chats: [{ pending: 0 }] });
    expect(recipient.blocks.some(block => block.text?.endsWith('pending 5'))).toBe(true);
    expect(recipient.live!.pendingPrompts).toHaveLength(19);
    expect(recipient.live!.pendingPrompts.at(-1)).toContain('pending 24');
  });

  it('resets a child wake budget when the person messages its parent', () => {
    const host = labHost('demo', { links: 'seed' });
    const bus = new LabEventBus(browserTimers);
    const runtime = new LabSessions(host.state, bus, new LabClock());
    const links = createLabSessionLinks(runtime, bus, true);
    const recipient = host.state.sessions.get(child)!;
    for (let wake = 0; wake < MAX_WAKES; wake += 1) {
      links.agentMessage(parent, child, `wake ${wake}`);
      runtime.interrupt(recipient);
    }
    links.agentMessage(parent, child, 'blocked');
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: child } })).toMatchObject({ chats: [{ pending: 1 }] });
    links.personMessage(parent);
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: child } })).toMatchObject({ chats: [{ pending: 1 }] });
    links.agentMessage(parent, child, 'after reset');
    expect(links.handlers.session_links_command_v1!({ command: { op: 'find', sessionId: child } })).toMatchObject({ chats: [{ pending: 0 }] });
    expect(recipient.live!.status).toBe('running');
    expect(recipient.blocks.some(block => block.text?.endsWith('blocked'))).toBe(true);
    expect(recipient.live!.pendingPrompts.at(-1)).toContain('after reset');
  });

  it('sanitizes sender titles and counts Unicode scalar text characters', async () => {
    const host = labHost('demo', { links: 'seed' });
    host.state.sessions.get(parent)!.title = '\u0000' + 'x'.repeat(81);
    await command(host, { op: 'send', fromSessionId: parent, toSessionId: child, text: '😀'.repeat(16000) });
    expect(host.state.sessions.get(child)!.blocks.some(block => block.text?.startsWith(`Message from the chat "${'x'.repeat(80)}", sent by the person:\n\n😀`))).toBe(true);
  });

  it('removes both sides of a link when a chat is deleted', async () => {
    const host = labHost('demo', { links: 'seed' });
    await host.invoke('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: child } });
    expect(await command(host, { op: 'find', sessionId: parent })).toMatchObject({ chats: [] });
  });
});
