import type {
  ReviewArea,
  ReviewDiffV1,
  ReviewFileV1,
  ReviewRequestV1,
  ReviewStatusV1,
} from '../../../../../contracts/workspace-review-v1';
import type {
  ChatPlacementV1,
  WorkspacePlacementCommandV1,
  WorkspacePlacementResultV1,
} from '../../../../../contracts/workspace-placement-v1';
import type { WorkspaceAdoptRequestV1, WorkspaceAdoptResultV1 } from '../../../../../contracts/workspace-adopt-v1';
import { folderSlug, plainBranchName } from '../branchNames';
import type { TimelineBlock } from '../types';
import type { DesktopTimelineBlock, WorkspaceResult } from './labContracts';
import { HOUR, MINUTE, seededIso } from './labClock';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { hashString, labUuid } from './labRandom';
import { boolean, decodeArgument, enumOf, object, option, string, tagged, u64 } from './labSchema';
import { harnessIdentitySchema, workspaceModelSchema } from './labSchemas';
import { newQueue, type LabProject, type LabSessionRecord } from './labState';
import {
  applyChange, changeOf, changes, changeText, fingerprintOf, hunksOf, lineCounts,
  type LabChange, type LabRepository,
} from './gitFake';
import type { LabNativeHistory } from './piHistoryFake';
import type { LabSessions } from './sessionRuntime';
import { DEMO_PROJECTS } from './scenarios/demoChats';
import { sha256Hex } from './sha256';
import { workspaceHandlers } from './workspaceFake';

/**
 * UI Lab fake of the session tools: workspace review v1 (an in-memory git
 * per project folder and worktree), placement v1 (worktree chats, handoff
 * links) and adopt v1 (continuing a terminal Pi session from the demo index
 * history). Same commands, JSON shapes and error codes as the host; nothing
 * touches a file or runs git.
 */
const PERMISSION = enumOf(['native', 'read-only', 'workspace-write', 'full-access']);
const AREA = enumOf(['staged', 'unstaged', 'untracked']);

const reviewSchema = tagged('type', {
  status: { sessionId: string },
  diff: { sessionId: string, path: string, area: AREA },
  stage: { sessionId: string, path: string, area: AREA, fingerprint: string, hunk: option(u64) },
  unstage: { sessionId: string, path: string, fingerprint: string, hunk: option(u64) },
  revert: { sessionId: string, path: string, area: AREA, fingerprint: string, hunk: option(u64) },
});

const worktreeSchema = tagged('type', {
  new: { branch: string, folder: string, expectedBase: string },
  shared: { sessionId: string },
});

const placementSchema = tagged('type', {
  list: {},
  previewWorktree: { workspaceId: string, branch: option(string) },
  createChat: {
    workspaceId: string,
    harness: harnessIdentitySchema,
    permissionMode: PERMISSION,
    title: option(string),
    model: option(workspaceModelSchema),
    worktree: option(worktreeSchema),
    continuedFrom: option(string),
  },
  removeWorktree: { sessionId: string, discardChanges: boolean, expectedChanges: option(string) },
});

const adoptSchema = object({ projectId: option(string), sessionId: string });

function failure(code: string, message: string): HostErrorPayload {
  return { code, message, recoverable: true };
}

const SAFE_MODE = failure('SAFE_MODE', 'Safe mode is on: PiUI does not change files, git or chats.');
const STALE = failure('STALE', 'This changed since you reviewed it. Check it again before continuing.');
const NOT_TRUSTED = failure('NOT_TRUSTED', 'Trust this project before starting a runtime.');
const NOT_FOUND = failure('NOT_FOUND', 'The workspace session was not found.');
const INVALID = failure('INVALID_ARGUMENT', 'Check the required fields and try again.');
const NOT_A_REPOSITORY = failure('NOT_A_REPOSITORY', 'This folder is not a git repository.');
const WORKTREE_REMOVED = failure(
  'WORKTREE_REMOVED',
  "This chat's worktree was removed. Its history stays readable; start a new chat to keep working.",
);

interface LabWorktree {
  branch: string;
  folder: string;
  path: string;
  base: string;
  repoKey: string;
  removed: boolean;
}

interface LabPlacement {
  worktree?: LabWorktree;
  continuedFrom?: string;
  adopted?: boolean;
}

export interface LabSessionTools {
  readonly repositories: Map<string, LabRepository>;
  readonly placements: Map<string, LabPlacement>;
  readonly branches: Map<string, Set<string>>;
  /** Index session id → adopted workspace chat. */
  readonly adopted: Map<string, string>;
  /** Index sessions the fake treats as still open in the Pi terminal app. */
  readonly activeInTerminal: Set<string>;
}

const TRANSPORT_HEAD = [
  "import { invoke } from '@tauri-apps/api/core';",
  "import { listen } from '@tauri-apps/api/event';",
  '',
  'export type HostInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;',
  'export type HostListen = <T>(channel: string, handler: (payload: T) => void) => Promise<() => void>;',
  '',
  'export interface HostTransport {',
  '  invoke: HostInvoke;',
  '  listen: HostListen;',
  '}',
  '',
  "export const desktopAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;",
  '',
  'const desktopTransport: HostTransport = {',
  '  invoke: (command, args) => invoke(command, args),',
  '  listen: async (channel, handler) => listen(channel, (event) => handler(event.payload as never)),',
  '};',
  '',
  'let labTransport: Promise<HostTransport> | undefined;',
  'function lab(): Promise<HostTransport> {',
  "  labTransport ??= import('./lab/labHost').then((module) => module.createLabHost());",
  '  return labTransport;',
  '}',
];

function text(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function edited(lines: readonly string[], changes: Readonly<Record<number, string>>, inserted: Readonly<Record<number, string[]>> = {}): string {
  const result: string[] = [];
  lines.forEach((line, index) => {
    for (const extra of inserted[index] ?? []) result.push(extra);
    result.push(changes[index] ?? line);
  });
  return text(result);
}

const SIDEBAR_HEAD = [
  '<nav class="sidebar" aria-label={$t(\'Workspace navigation\')}>',
  '  <div class="brand">',
  '    <span class="brand__mark" aria-hidden="true">π</span>',
  '    <span class="brand__name">PiUI</span>',
  '  </div>',
  '</nav>',
];

const LAYOUT_HEAD = [
  '.review {',
  '  display: grid;',
  '  grid-template-rows: auto minmax(0, 1fr);',
  '  gap: 8px;',
  '}',
  '.review__files {',
  '  max-height: 40%;',
  '}',
];

function commitId(seed: string): string {
  return sha256Hex(seed).slice(0, 40);
}

function demoRepository(): LabRepository {
  const files = new Map([
    ['apps/desktop/src/host-api/transport.ts', {
      head: text(TRANSPORT_HEAD),
      index: text(TRANSPORT_HEAD),
      worktree: edited(TRANSPORT_HEAD, {
        3: '/** Every host call goes through this one function. */',
        22: '  labTransport ??= import(\'./lab/labHost\').then((module) => module.createLabHost({ ambient: true }));',
      }, { 3: ['// Typed boundary between the WebView and the host.'] }),
    }],
    ['apps/desktop/src/app/shell/Sidebar.svelte', {
      head: text(SIDEBAR_HEAD),
      index: edited(SIDEBAR_HEAD, { 3: '    <span class="brand__name">PiUI Lab</span>' }),
      worktree: edited(SIDEBAR_HEAD, { 3: '    <span class="brand__name">PiUI Lab</span>' }),
    }],
    ['docs/OLD_NOTES.md', { head: 'Old notes that nobody reads.\n', index: 'Old notes that nobody reads.\n' }],
    ['apps/desktop/icons/badge.png', { head: 'png-v1', index: 'png-v1', worktree: 'png-v2-larger', binary: true }],
    ['docs/notes/review-panel.md', { worktree: text(['# Review panel', '', '- Stage and revert per hunk.', '- Comment on a line for the agent.']) }],
  ]);
  return { branch: 'main', head: commitId('lab:piui:head'), folder: 'piui', worktree: false, files, trash: [] };
}

function cleanRepository(folder: string): LabRepository {
  return {
    branch: 'main',
    head: commitId(`lab:${folder}:head`),
    folder,
    worktree: false,
    files: new Map([['README.md', { head: `# ${folder}\n`, index: `# ${folder}\n`, worktree: `# ${folder}\n` }]]),
    trash: [],
  };
}

/** A fresh checkout of `source`'s HEAD: no changes, nothing copied from its work tree. */
function checkout(source: LabRepository, branch: string, folder: string): LabRepository {
  const files = new Map<string, { head?: string; index?: string; worktree?: string; binary?: boolean }>();
  for (const [path, file] of source.files) {
    if (file.head === undefined) continue;
    files.set(path, { head: file.head, index: file.head, worktree: file.head, ...(file.binary ? { binary: true } : {}) });
  }
  return { branch, head: source.head, folder, worktree: true, files, trash: [] };
}

export const DEMO_WORKTREE_SESSION = labUuid('demo:session:worktree-layout');

function worktreeChat(workspaceId: string): LabSessionRecord {
  const at = seededIso(-25 * MINUTE);
  const blocks: DesktopTimelineBlock[] = [
    { id: 'worktree-1', kind: 'user', label: 'You', text: 'Try a denser layout for the review panel on this branch.', status: 'complete', createdAt: seededIso(-40 * MINUTE) },
    { id: 'worktree-2', kind: 'assistant', label: 'Codex', text: 'I tightened the file list and gave the diff more room. The changes are in `docs/review-layout.css`.', status: 'complete', createdAt: at },
  ];
  return {
    id: DEMO_WORKTREE_SESSION,
    workspaceId,
    harness: 'codex',
    title: 'Try a denser review layout',
    updatedAt: at,
    permissionMode: 'workspace-write',
    revision: blocks.length + 2,
    blocks,
    usage: [],
    composer: newQueue(),
    turnSerial: 0,
  };
}

function seed(tools: LabSessionTools, runtime: LabSessions): void {
  const { state } = runtime;
  const piui = state.projects.find((project) => project.id === DEMO_PROJECTS.piui);
  if (piui === undefined) return;
  const repository = demoRepository();
  tools.repositories.set(piui.id, repository);
  tools.branches.set(piui.id, new Set(['main']));
  const video = state.projects.find((project) => project.id === DEMO_PROJECTS.video);
  if (video !== undefined) tools.repositories.set(video.id, cleanRepository('video-studio'));
  const legacy = state.projects.find((project) => project.id === DEMO_PROJECTS.legacy);
  if (legacy !== undefined) tools.repositories.set(legacy.id, cleanRepository('legacy-repo'));

  const worktree = checkout(repository, 'piui/review-layout', 'review-layout');
  worktree.files.set('docs/review-layout.css', { worktree: text(LAYOUT_HEAD) });
  const readme = [...repository.files.keys()][0];
  if (readme !== undefined) {
    const file = worktree.files.get(readme);
    if (file?.worktree !== undefined) file.worktree = `${file.worktree}// Denser review layout.\n`;
  }
  tools.repositories.set('worktree:review-layout', worktree);
  tools.branches.get(piui.id)?.add('piui/review-layout');
  const record = worktreeChat(piui.id);
  state.sessions.set(record.id, record);
  tools.placements.set(record.id, {
    worktree: {
      branch: 'piui/review-layout',
      folder: 'review-layout',
      path: worktreePath(piui, 'review-layout'),
      base: repository.head,
      repoKey: 'worktree:review-layout',
      removed: false,
    },
  });
  tools.activeInTerminal.add(labIndexId('release-notes'));
}

/** The demo history ids (`entryId('session:<key>')` in `demoPiHistory`). */
function labIndexId(key: string): string {
  return hashString(`session:${key}`).toString(16).padStart(8, '0').slice(0, 8);
}

function worktreePath(project: LabProject, folder: string): string {
  return `~/.piui-lab/worktrees/${folderSlug(project.name)}-${sha256Hex(project.id).slice(0, 8)}/${folder}`;
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

export function createSessionTools(runtime: LabSessions): LabSessionTools {
  const tools: LabSessionTools = {
    repositories: new Map(),
    placements: new Map(),
    branches: new Map(),
    adopted: new Map(),
    activeInTerminal: new Set(),
  };
  if (runtime.state.scenario === 'demo' || runtime.state.scenario === 'safe') seed(tools, runtime);
  return tools;
}

function placementView(sessionId: string, placement: LabPlacement): ChatPlacementV1 {
  return {
    sessionId,
    ...(placement.worktree === undefined
      ? {}
      : {
        worktree: {
          branch: placement.worktree.branch,
          path: placement.worktree.path,
          state: placement.worktree.removed ? 'removed' as const : 'ready' as const,
          base: short(placement.worktree.base),
        },
      }),
    ...(placement.continuedFrom === undefined ? {} : { continuedFrom: placement.continuedFrom }),
    ...(placement.adopted ? { adopted: true as const } : {}),
  };
}

export function sessionToolsHandlers(runtime: LabSessions, history: LabNativeHistory, tools: LabSessionTools = createSessionTools(runtime)): LabHandlers {
  const { state } = runtime;
  const workspace = workspaceHandlers(runtime);

  function project(workspaceId: string, trusted: boolean): LabProject {
    const found = state.projects.find((candidate) => candidate.id === workspaceId);
    if (found === undefined) throw NOT_FOUND;
    if (trusted && found.trustState !== 'trusted') throw NOT_TRUSTED;
    if (found.missing) throw failure('PROJECT_UNAVAILABLE', 'The project folder is unavailable.');
    return found;
  }

  function record(sessionId: string): LabSessionRecord {
    const found = state.sessions.get(sessionId);
    if (found === undefined) throw NOT_FOUND;
    return found;
  }

  /** The repository a chat works in, or undefined when it has none. */
  function repositoryOf(sessionId: string): LabRepository | undefined {
    const chat = record(sessionId);
    const owner = project(chat.workspaceId, true);
    const worktree = tools.placements.get(sessionId)?.worktree;
    if (worktree?.removed) throw WORKTREE_REMOVED;
    if (worktree !== undefined) return tools.repositories.get(worktree.repoKey);
    return owner.personal ? undefined : tools.repositories.get(owner.id);
  }

  // ---- review ---------------------------------------------------------------

  function file(change: LabChange): ReviewFileV1 {
    const counts = change.binary ? undefined : change.area === 'untracked' ? undefined : lineCounts(change);
    return {
      path: change.path,
      area: change.area,
      change: change.change,
      ...(counts === undefined ? {} : counts),
      ...(change.binary && change.area !== 'untracked' ? { binary: true as const } : {}),
    };
  }

  function status(sessionId: string): ReviewStatusV1 {
    const repository = repositoryOf(sessionId);
    if (repository === undefined) {
      return { protocol: 1, type: 'status', sessionId, repository: { state: 'not-repository' }, files: [], truncated: false, hidden: 0, readOnly: state.safeMode };
    }
    return {
      protocol: 1,
      type: 'status',
      sessionId,
      repository: {
        state: 'ready',
        ...(repository.branch === undefined ? {} : { branch: repository.branch }),
        head: short(repository.head),
        worktree: repository.worktree,
        folder: repository.folder,
      },
      files: changes(repository).map(file),
      truncated: false,
      hidden: 0,
      readOnly: state.safeMode,
    };
  }

  function located(sessionId: string, path: string, area: ReviewArea): { repository: LabRepository; change: LabChange } {
    if (path === '' || path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw INVALID;
    const repository = repositoryOf(sessionId);
    if (repository === undefined) throw NOT_A_REPOSITORY;
    const change = changeOf(repository, path, area);
    if (change === undefined) throw STALE;
    return { repository, change };
  }

  function diff(sessionId: string, path: string, area: ReviewArea): ReviewDiffV1 {
    const { change } = located(sessionId, path, area);
    const hunks = hunksOf(change.before, change.after).length;
    const selectable = change.change === 'modified' && !change.binary && change.area !== 'untracked';
    return {
      protocol: 1,
      type: 'diff',
      sessionId,
      path,
      area,
      fingerprint: fingerprintOf(change),
      content: change.binary
        ? { kind: 'binary', size: change.after?.length ?? 0 }
        : { kind: 'text', text: changeText(change), hunks, hunkActions: selectable && hunks > 0 },
      actions: {
        stage: area !== 'staged',
        unstage: area === 'staged',
        revert: area !== 'staged',
      },
    };
  }

  function act(request: Exclude<ReviewRequestV1, { type: 'status' | 'diff' }>): ReviewStatusV1 {
    if (state.safeMode) throw SAFE_MODE;
    if (!/^[0-9a-f]{64}$/.test(request.fingerprint)) throw INVALID;
    const area: ReviewArea = request.type === 'unstage' ? 'staged' : request.area;
    const { repository, change } = located(request.sessionId, request.path, area);
    if (fingerprintOf(change) !== request.fingerprint) throw STALE;
    if (request.hunk !== undefined && (change.binary || change.change !== 'modified' || area === 'untracked')) {
      throw failure('NOT_SUPPORTED', 'This change can only be handled as a whole file.');
    }
    if (request.type === 'stage' && area === 'staged') throw INVALID;
    if (request.type === 'revert' && area === 'staged') throw failure('NOT_SUPPORTED', 'Unstage these changes first, then revert them.');
    try {
      applyChange(repository, change, request.type, request.hunk);
    } catch {
      throw STALE;
    }
    return status(request.sessionId);
  }

  function review(request: ReviewRequestV1): ReviewStatusV1 | ReviewDiffV1 {
    switch (request.type) {
      case 'status':
        return status(request.sessionId);
      case 'diff':
        return diff(request.sessionId, request.path, request.area);
      case 'stage':
      case 'unstage':
      case 'revert':
        return act(request);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  // ---- placement ------------------------------------------------------------

  function suggestedBranch(): string {
    return `piui/chat-${state.ids.next('branch').replace(/[^0-9a-f]/g, '').slice(0, 6).padEnd(6, '0')}`;
  }

  function preview(workspaceId: string, requested: string | undefined): WorkspacePlacementResultV1 {
    if (state.safeMode) throw SAFE_MODE;
    const owner = project(workspaceId, true);
    if (owner.personal) throw failure('NOT_SUPPORTED', 'Worktrees are for project folders. Personal chats have no repository.');
    const repository = tools.repositories.get(owner.id);
    if (repository === undefined) throw NOT_A_REPOSITORY;
    const branch = requested ?? suggestedBranch();
    if (!plainBranchName(branch)) throw failure('INVALID_BRANCH', "Choose a branch name with letters, digits, '.', '_', '-' and '/'.");
    if (tools.branches.get(owner.id)?.has(branch)) throw failure('BRANCH_EXISTS', 'A branch with this name already exists. Choose another name.');
    const base = folderSlug(branch);
    let folder = base;
    for (let attempt = 2; tools.repositories.has(`worktree:${folder}`); attempt += 1) folder = `${base}-${attempt}`;
    return {
      protocol: 1,
      type: 'preview',
      preview: {
        workspaceId,
        branch,
        folder,
        path: worktreePath(owner, folder),
        base: { commit: repository.head, short: short(repository.head), ...(repository.branch === undefined ? {} : { branch: repository.branch }) },
        projectChanges: changes(repository).length > 0,
      },
    };
  }

  async function createChat(command: Extract<WorkspacePlacementCommandV1, { type: 'createChat' }>): Promise<WorkspacePlacementResultV1> {
    if (state.safeMode) throw SAFE_MODE;
    if (command.worktree === undefined && command.continuedFrom === undefined) throw INVALID;
    if (command.continuedFrom !== undefined && state.sessions.get(command.continuedFrom)?.workspaceId !== command.workspaceId) {
      throw failure('NOT_FOUND', 'The chat this one continues is no longer available.');
    }
    const placement: LabPlacement = command.continuedFrom === undefined ? {} : { continuedFrom: command.continuedFrom };
    const owner = project(command.workspaceId, true);
    if (command.worktree?.type === 'new') {
      const planned = preview(command.workspaceId, command.worktree.branch);
      if (planned.type !== 'preview') throw INVALID;
      if (planned.preview.base.commit !== command.worktree.expectedBase || planned.preview.folder !== command.worktree.folder) throw STALE;
      const source = tools.repositories.get(owner.id);
      if (source === undefined) throw NOT_A_REPOSITORY;
      const repoKey = `worktree:${command.worktree.folder}`;
      tools.repositories.set(repoKey, checkout(source, command.worktree.branch, command.worktree.folder));
      tools.branches.get(owner.id)?.add(command.worktree.branch);
      placement.worktree = {
        branch: command.worktree.branch,
        folder: command.worktree.folder,
        path: planned.preview.path,
        base: source.head,
        repoKey,
        removed: false,
      };
    } else if (command.worktree?.type === 'shared') {
      const shared = tools.placements.get(command.worktree.sessionId)?.worktree;
      if (state.sessions.get(command.worktree.sessionId)?.workspaceId !== command.workspaceId || shared === undefined) {
        throw failure('NOT_FOUND', 'That chat does not run in a worktree.');
      }
      if (shared.removed) throw WORKTREE_REMOVED;
      placement.worktree = shared;
    }
    let created: WorkspaceResult | undefined;
    try {
      created = await workspace.workspace_command_v15?.({
        command: {
          type: 'createSession',
          workspaceId: command.workspaceId,
          harness: command.harness,
          permissionMode: command.permissionMode,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.model === undefined ? {} : { model: command.model }),
        },
      }) as WorkspaceResult | undefined;
    } catch (error) {
      // Like the host: the fresh worktree goes, its branch stays.
      if (command.worktree?.type === 'new') tools.repositories.delete(`worktree:${command.worktree.folder}`);
      throw error;
    }
    if (created?.type !== 'session') throw INVALID;
    tools.placements.set(created.snapshot.session.id, placement);
    return { protocol: 1, type: 'created', snapshot: created.snapshot, placement: placementView(created.snapshot.session.id, placement) };
  }

  function remove(sessionId: string, discard: boolean, expected: string | undefined): WorkspacePlacementResultV1 {
    if (state.safeMode) throw SAFE_MODE;
    const chat = record(sessionId);
    project(chat.workspaceId, true);
    const placement = tools.placements.get(sessionId);
    const worktree = placement?.worktree;
    if (worktree === undefined) throw failure('NOT_FOUND', 'This chat does not run in a worktree.');
    if (worktree.removed) throw WORKTREE_REMOVED;
    const repository = tools.repositories.get(worktree.repoKey);
    const pending = repository === undefined ? [] : changes(repository);
    if (pending.length > 0) {
      const fingerprint = sha256Hex(pending.map((change) => `${change.area}:${change.path}`).sort().join('\n'));
      if (!discard) return { protocol: 1, type: 'dirty', sessionId, changes: pending.length, fingerprint };
      if (expected !== fingerprint) throw STALE;
    }
    for (const [id, other] of tools.placements) {
      if (other.worktree?.repoKey !== worktree.repoKey) continue;
      const bound = state.sessions.get(id);
      const status = bound?.live?.status;
      if (status === 'starting' || status === 'running' || status === 'stopping') throw failure('CONFLICT', 'The workspace session changed during this operation.');
    }
    for (const [id, other] of tools.placements) {
      if (other.worktree?.repoKey !== worktree.repoKey) continue;
      const bound = state.sessions.get(id);
      if (bound?.live !== undefined) runtime.close(bound);
    }
    worktree.removed = true;
    tools.repositories.delete(worktree.repoKey);
    return { protocol: 1, type: 'removed', sessionId, placement: placementView(sessionId, placement ?? {}) };
  }

  async function placementCommand(command: WorkspacePlacementCommandV1): Promise<WorkspacePlacementResultV1> {
    switch (command.type) {
      case 'list':
        return {
          protocol: 1,
          type: 'placements',
          placements: [...tools.placements.entries()]
            .filter(([sessionId]) => state.sessions.has(sessionId))
            .map(([sessionId, placement]) => placementView(sessionId, placement)),
        };
      case 'previewWorktree':
        return preview(command.workspaceId, command.branch);
      case 'createChat':
        return createChat(command);
      case 'removeWorktree':
        return remove(command.sessionId, command.discardChanges, command.expectedChanges);
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  // ---- adoption -------------------------------------------------------------

  function workspaceBlock(block: TimelineBlock): DesktopTimelineBlock {
    return { ...block, label: block.label ?? (block.kind === 'user' ? 'You' : block.kind === 'assistant' ? 'Pi' : 'Tool activity') };
  }

  function adopt(request: WorkspaceAdoptRequestV1): WorkspaceAdoptResultV1 {
    if (state.safeMode) throw SAFE_MODE;
    const personal = state.projects.find((candidate) => candidate.personal);
    if (request.projectId !== undefined && request.projectId === personal?.id) throw INVALID;
    const owner = request.projectId === undefined ? personal : state.projects.find((candidate) => candidate.id === request.projectId);
    if (owner === undefined) throw NOT_FOUND;
    project(owner.id, true);
    if (owner.agentKind === 'prime-agent') {
      throw failure('NOT_SUPPORTED', 'Prime Agent live control is disabled. Read-only history remains available.');
    }
    const indexed = history.byProject.get(owner.id)?.find((entry) => entry.summary.id === request.sessionId);
    if (indexed === undefined) throw NOT_FOUND;
    const existing = tools.adopted.get(request.sessionId);
    if (existing !== undefined && state.sessions.has(existing)) return { protocol: 1, sessionId: existing, created: false };
    if (tools.activeInTerminal.has(request.sessionId)) {
      throw failure(
        'SESSION_ALREADY_ACTIVE',
        'This session was written moments ago and may still be open in the Pi terminal app. Close it there, then try again.',
      );
    }
    const id = state.ids.next('session');
    const chat: LabSessionRecord = {
      id,
      workspaceId: owner.id,
      harness: 'pi',
      title: indexed.summary.title,
      updatedAt: indexed.summary.updatedAt ?? seededIso(-HOUR),
      permissionMode: 'native',
      revision: indexed.blocks.length + 2,
      blocks: indexed.blocks.map(workspaceBlock),
      usage: [],
      composer: newQueue(),
      turnSerial: 0,
    };
    state.sessions.set(id, chat);
    tools.adopted.set(request.sessionId, id);
    tools.placements.set(id, { adopted: true });
    return { protocol: 1, sessionId: id, created: true };
  }

  return {
    workspace_review_v1: (args) => review(decodeArgument<ReviewRequestV1>(args, 'request', reviewSchema)),
    workspace_placement_v1: (args) =>
      placementCommand(decodeArgument<WorkspacePlacementCommandV1>(args, 'command', placementSchema)),
    workspace_adopt_v1: (args) => adopt(decodeArgument<WorkspaceAdoptRequestV1>(args, 'request', adoptSchema)),
  };
}
