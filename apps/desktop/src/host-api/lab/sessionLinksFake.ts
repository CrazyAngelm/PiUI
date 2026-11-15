import { SESSION_LINKS_EVENT_V1, type LinkKindV1, type LinkedChatV1, type SessionLinksCommandV1, type SessionLinksErrorCodeV1, type SessionLinksResultV1 } from '../../../../../contracts/session-links-v1';
import type { LabEventBus } from './labBus';
import type { LabHandlers } from './labHandlers';
import { boolean, decodeArgument, string, tagged } from './labSchema';
import type { LabSessionRecord } from './labState';
import type { LabSessions } from './sessionRuntime';

interface Link {
  other: string;
  kind: LinkKindV1;
  relation: LinkedChatV1['relation'];
  pending: { text: string; agent: boolean }[];
  lastReport?: LinkedChatV1['lastReport'];
}
interface Document { links: Link[]; wakes: number; revision: number }
export const MAX_WAKES = 8;
const commandSchema = tagged('op', {
  find: { sessionId: string }, link: { sessionId: string, otherSessionId: string }, unlink: { sessionId: string, otherSessionId: string },
  send: { fromSessionId: string, toSessionId: string, text: string }, deliver: { sessionId: string, fromSessionId: string }, settings: {}, update: { enabled: boolean },
});
const titleOf = (title: string): string => [...title.replace(/\p{Cc}/gu, '')].slice(0, 80).join('');
const validText = (text: string): boolean => [...text].length > 0 && [...text].length <= 16000;
const fail = (code: SessionLinksErrorCodeV1, message: string): never => { throw { code, message }; };

/** In-memory mirror of the host broker's person-facing commands. No native history is rewritten. */
export function createLabSessionLinks(runtime: LabSessions, bus: LabEventBus, seed: boolean = false) {
  const documents = new Map<string, Document>();
  let enabled = true;
  const document = (id: string): Document => {
    let value = documents.get(id);
    if (!value) { value = { links: [], wakes: 0, revision: 0 }; documents.set(id, value); }
    return value;
  };
  const changed = (id: string): void => {
    const value = document(id);
    value.revision += 1;
    bus.emit(SESSION_LINKS_EVENT_V1, { sessionId: id, revision: value.revision });
  };
  const session = (id: string): LabSessionRecord => {
    const record = runtime.record(id);
    if (!record) return fail('unknown-session', 'This chat is not linked to this one.');
    return record;
  };
  const direct = (id: string): LabSessionRecord => {
    const record = session(id);
    if (record.runId !== undefined || runtime.state.isFusionSidekick?.(id)) return fail('not-allowed', 'Linked chats are not available for this session.');
    return record;
  };
  const link = (id: string, other: string): Link => document(id).links.find(item => item.other === other)
    ?? fail('unknown-session', 'This chat is not linked to this one.');
  const pair = (parent: string, child: string, kind: LinkKindV1): void => {
    document(parent).links.push({ other: child, kind, relation: kind === 'peer' ? 'peer' : 'child', pending: [] });
    document(child).links.push({ other: parent, kind, relation: kind === 'peer' ? 'peer' : 'parent', pending: [] });
    changed(parent); changed(child);
  };
  const summary = (value: Link): LinkedChatV1 => {
    const record = session(value.other);
    const status = record.live?.status ?? 'closed';
    return {
      sessionId: record.id, title: titleOf(record.title), harness: record.harness, kind: value.kind, relation: value.relation,
      state: status === 'stopping' ? 'running' : status, pending: value.pending.length,
      ...(value.lastReport === undefined ? {} : { lastReport: { ...value.lastReport } }),
    };
  };
  const post = (to: string, framed: string, agent: boolean): boolean => {
    const target = direct(to);
    const host = runtime.state.harnesses.find(item => item.kind === target.harness);
    if (!target.live && (!host || host.status !== 'available')) return false;
    const project = runtime.state.projects.find(item => item.id === target.workspaceId);
    if (!project || project.missing || project.trustState !== 'trusted') return false;
    if (!target.live) runtime.open(target);
    const active = target.live?.status === 'running' || target.live?.status === 'starting' || target.live?.status === 'stopping';
    const value = document(to);
    if (agent && !active && value.wakes >= MAX_WAKES) return false;
    if (agent && !active) { value.wakes += 1; changed(to); }
    try { runtime.prompt(target, framed, active ? 'follow-up' : 'prompt'); }
    catch {
      if (agent && !active) value.wakes -= 1;
      return false;
    }
    runtime.publishSession(target);
    return true;
  };
  const flush = (to: string, from: string): void => {
    const value = link(to, from);
    while (value.pending.length) {
      const pending = value.pending[0]!;
      if (!post(to, pending.text, pending.agent)) break;
      value.pending.shift(); changed(to);
    }
  };
  const queue = (to: string, from: string, text: string, agent: boolean): void => {
    const incoming = link(to, from);
    incoming.pending.push({ text, agent });
    incoming.pending = incoming.pending.slice(-20);
    changed(to);
    flush(to, from);
  };
  const personMessage = (id: string): void => {
    const value = document(id);
    value.wakes = 0;
    for (const linked of value.links) {
      if (linked.relation === 'child' && (linked.kind === 'agent' || linked.kind === 'branch')) document(linked.other).wakes = 0;
    }
  };
  const sessionDeleted = (id: string): void => {
    const previous = documents.get(id);
    if (!previous) return;
    for (const value of previous.links) {
      const other = documents.get(value.other);
      if (!other) continue;
      other.links = other.links.filter(item => item.other !== id);
      changed(value.other);
    }
    previous.links = [];
    changed(id);
    documents.delete(id);
  };
  const agentMessage = (from: string, to: string, text: string): void => {
    if (runtime.state.safeMode) fail('read-only', 'Linked chats are read-only in safe mode.');
    if (!validText(text)) fail('invalid-operation', 'The sessions operation is invalid.');
    const sender = direct(from);
    const framed = `Message from the linked chat "${titleOf(sender.title)}" (another agent, not the person):\n\n${text}`;
    queue(to, from, framed, true);
  };
  // Opt-in (`?links=seed`): the default demo keeps every chat a top-level row.
  if (seed && (runtime.state.scenario === 'demo' || runtime.state.scenario === 'safe')) {
    const chats = [...runtime.state.sessions.values()].filter(value => value.runId === undefined);
    const parent = chats[0], child = chats.find(value => value.id !== parent?.id && value.workspaceId === parent?.workspaceId);
    if (parent && child) {
      pair(parent.id, child.id, 'agent');
      link(parent.id, child.id).lastReport = { at: runtime.clock.iso(), excerpt: 'The linked review is complete. Read the child chat for its full answer.' };
      changed(parent.id);
    }
  }
  const handlers: LabHandlers = {
    session_links_command_v1: args => {
      const command = decodeArgument<SessionLinksCommandV1>(args, 'command', commandSchema);
      const settings = (): SessionLinksResultV1 => ({ type: 'settings', enabled: enabled && !runtime.state.safeMode, readOnly: runtime.state.safeMode });
      if (command.op === 'settings') return settings();
      if (command.op === 'find') {
        session(command.sessionId);
        const value = document(command.sessionId);
        return { type: 'links', sessionId: command.sessionId, chats: value.links.filter(item => runtime.record(item.other)).map(summary), revision: value.revision } satisfies SessionLinksResultV1;
      }
      if (runtime.state.safeMode) fail('read-only', 'Linked chats are read-only in safe mode.');
      switch (command.op) {
        case 'update': enabled = command.enabled; return settings();
        case 'link': {
          direct(command.sessionId); direct(command.otherSessionId);
          if (command.sessionId === command.otherSessionId) fail('invalid-operation', 'The sessions operation is invalid.');
          if (!document(command.sessionId).links.some(item => item.other === command.otherSessionId)) pair(command.sessionId, command.otherSessionId, 'peer');
          break;
        }
        case 'unlink': {
          direct(command.sessionId); direct(command.otherSessionId); link(command.sessionId, command.otherSessionId);
          document(command.sessionId).links = document(command.sessionId).links.filter(item => item.other !== command.otherSessionId);
          document(command.otherSessionId).links = document(command.otherSessionId).links.filter(item => item.other !== command.sessionId);
          changed(command.sessionId); changed(command.otherSessionId); break;
        }
        case 'send': {
          const sender = direct(command.fromSessionId);
          direct(command.toSessionId); link(command.toSessionId, sender.id);
          if (!validText(command.text)) fail('invalid-operation', 'The sessions operation is invalid.');
          document(command.toSessionId).wakes = 0;
          queue(command.toSessionId, sender.id, `Message from the chat "${titleOf(sender.title)}", sent by the person:\n\n${command.text}`, false); break;
        }
        case 'deliver':
          direct(command.sessionId); session(command.fromSessionId); link(command.sessionId, command.fromSessionId);
          document(command.sessionId).wakes = 0; flush(command.sessionId, command.fromSessionId); break;
      }
      return { type: 'done' } satisfies SessionLinksResultV1;
    },
  };
  /** A branch chat joins its source as a child (`branch` link), as the host records it. */
  const adopt = (parentId: string, childId: string): void => {
    if (!runtime.record(parentId) || !runtime.record(childId)) return;
    if (!document(parentId).links.some(item => item.other === childId)) pair(parentId, childId, 'branch');
  };
  return { handlers, agentMessage, personMessage, sessionDeleted, adopt };
}
