import type {
  ComposerAttachmentsResult,
  ComposerImage,
  ComposerImageType,
  ComposerInputsCommand,
  ComposerInputsResult,
  HarnessKind,
  NativeCommand,
  NativeSkill,
  WorkspaceModel,
} from './labContracts';
import { workspaceFailure } from './labErrors';
import { authorizeLive, requireLive, validToken } from './labGuards';
import type { LabHandlers } from './labHandlers';
import { isUuid } from './labRandom';
import { decodeArgument } from './labSchema';
import { composerInputsCommandSchema } from './labSchemas';
import { verifiedProject, type LabState } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * Composer inputs v1 (`workspace_composer_inputs_v1`) for the UI Lab. It
 * mirrors the host rules (safe mode, trusted projects, sniffed and bounded
 * images, single-use drops, bounded file names, live-session catalogs) with
 * fixed fake data: no file is read, no dialog opens and nothing is executed.
 */
export const MAX_LAB_IMAGE_BYTES = 5_000_000;
const MAX_LAB_FILES = 2_000;
const MAX_PENDING = 64;

/** A 48×32 PNG "screenshot" returned by the lab's file dialog. */
export const LAB_SCREENSHOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAY0lEQVR4nGPQUtMYVIhhwF0w6qAh76AKDYtBhUYdNPQchJam3rx4RGdEIJchK63IK6EEUd9Bgy6ERh005BxEYaImMrEP5RAaddCQc9BoST3qoGHnoNGSGpuDBhyNOmjUQZQiAPldjjHC8MlzAAAAAElFTkSuQmCC';

interface LabAttachment {
  image: ComposerImage;
  data: string;
  /** Pending until a queued message claims it. */
  pending: boolean;
}

/** Composer images live beside the lab state, like the host's app-data store. */
const stores = new WeakMap<LabState, Map<string, LabAttachment>>();
function attachmentStore(state: LabState): Map<string, LabAttachment> {
  let store = stores.get(state);
  if (store === undefined) {
    store = new Map();
    stores.set(state, store);
  }
  return store;
}

/** A plausible project tree; `.gitignore`d and hidden paths are already left out. */
export const LAB_PROJECT_FILES: readonly string[] = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'docs/architecture.md',
  'docs/lab-spec.pdf',
  'docs/release-notes.md',
  'src/main.ts',
  'src/app/App.svelte',
  'src/app/chat/ChatComposer.svelte',
  'src/app/chat/transcript/Transcript.svelte',
  'src/app/shell/AppShell.svelte',
  'src/app/shell/NewChatComposer.svelte',
  'src/app/shell/Sidebar.svelte',
  'src/host-api/transport.ts',
  'src/host-api/workspaceClient.ts',
  'src/lib/ui/Button.svelte',
  'src/lib/ui/Picker.svelte',
  'src/styles/tokens.css',
  'tests/composer.spec.ts',
  'tests/transport.test.ts',
];

/** Mirrors the bridges: which harness and model accept native image input. */
export function labImageSupport(kind: HarnessKind, model: WorkspaceModel | undefined): boolean {
  switch (kind) {
    case 'pi':
      // A local text-only model declares no image input.
      return model?.id !== 'qwen-lab-coder';
    case 'codex':
    case 'claude-code':
    case 'hermes':
      return true;
    case 'prime-agent':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Native `/` commands and `$` skills each lab harness reports. */
export function labComposerCatalog(kind: HarnessKind): { commands: NativeCommand[]; skills: NativeSkill[] } {
  switch (kind) {
    case 'pi':
      return {
        commands: [
          { name: 'deploy-preview', description: 'Deploy a preview build (lab extension)', source: 'extension' },
          { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
          { name: 'skill:release-notes', description: 'Draft release notes from the changelog', source: 'skill' },
          { name: 'skill:lab-changelog', description: 'Summarize recent commits', source: 'skill' },
        ],
        skills: [],
      };
    case 'claude-code':
      return {
        commands: [
          { name: 'review', description: 'Review the current changes', source: 'command' },
          { name: 'security-review', description: 'Complete a security review of the pending changes', source: 'command' },
          { name: 'lab-release-notes', description: 'Write release notes (lab skill)', hint: '<version>', source: 'command' },
        ],
        skills: [],
      };
    case 'codex':
      return {
        commands: [],
        skills: [{ name: 'test-runner', description: 'Run the test suite and summarize failures', mention: '$test-runner' }],
      };
    case 'hermes':
      return {
        commands: [
          { name: 'help', description: 'List available commands', source: 'command' },
          { name: 'model', description: 'Show current model and provider, or switch models', hint: 'model name to switch to', source: 'command' },
          { name: 'compress', description: 'Compress conversation context', source: 'command' },
        ],
        skills: [],
      };
    case 'prime-agent':
      return { commands: [], skills: [] };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function sniff(bytes: Uint8Array): ComposerImageType | undefined {
  const starts = (prefix: readonly number[], offset = 0) => prefix.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

function decodeBase64(data: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return undefined;
  try {
    const binary = atob(data);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function displayName(value: string, fallback: string): string {
  const base = [...(value.split(/[\\/]/).pop() ?? '')].filter((character) => character >= ' ' && character !== '\u007f').join('').trim();
  return base === '' || base === '.' || base === '..' ? fallback : base.slice(0, 128);
}

function attachments(partial: Partial<Omit<ComposerAttachmentsResult, 'type' | 'protocol'>>): ComposerAttachmentsResult {
  return { type: 'attachments', protocol: 1, images: [], files: [], rejected: [], ...partial };
}

/** Stores sniffed image bytes as a pending image, like `AttachmentStore::insert`. */
function insert(state: LabState, name: string, data: string): ComposerAttachmentsResult {
  const bytes = decodeBase64(data);
  if (bytes === undefined) throw workspaceFailure('INVALID_ARGUMENT');
  if (bytes.length > MAX_LAB_IMAGE_BYTES) return attachments({ rejected: [{ name, reason: 'too-large' }] });
  const mimeType = sniff(bytes);
  if (mimeType === undefined) return attachments({ rejected: [{ name, reason: 'not-an-image' }] });
  const store = attachmentStore(state);
  if ([...store.values()].filter((item) => item.pending).length >= MAX_PENDING) {
    return attachments({ rejected: [{ name, reason: 'limit' }] });
  }
  const image: ComposerImage = { id: state.ids.next('composer-image'), name, mimeType, size: bytes.length };
  store.set(image.id, { image, data, pending: true });
  return attachments({ images: [image] });
}

/** `validate_workspace_id` + `verified_project_directory(.., true)`. */
function trustedProject(state: LabState, workspaceId: string): void {
  if (!validToken(workspaceId) || workspaceId.length > 256) throw workspaceFailure('INVALID_ARGUMENT');
  verifiedProject(state, workspaceId, true);
}

function matches(needle: string, path: string): boolean {
  let index = 0;
  for (const character of path.toLowerCase()) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

/**
 * Hands pending images to a queued message (`AttachmentStore::claim_with`).
 * Every id must name a distinct pending image; nothing changes otherwise.
 */
export function claimLabImages(state: LabState, ids: readonly string[]): ComposerImage[] {
  const store = attachmentStore(state);
  const seen = new Set<string>();
  const images = ids.map((id) => {
    const item = store.get(id);
    if (item === undefined || !item.pending || seen.has(id)) throw workspaceFailure('ATTACHMENT_UNAVAILABLE');
    seen.add(id);
    return item.image;
  });
  for (const id of ids) {
    const item = store.get(id);
    if (item) item.pending = false;
  }
  return images;
}

/** Delivered or removed messages release their image bytes. */
export function releaseLabImages(state: LabState, images: readonly ComposerImage[]): void {
  const store = attachmentStore(state);
  for (const image of images) store.delete(image.id);
}

function composerInputs(runtime: LabSessions, command: ComposerInputsCommand): ComposerInputsResult {
  const { state } = runtime;
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  const store = attachmentStore(state);
  switch (command.type) {
    case 'pick':
      trustedProject(state, command.workspaceId);
      // The lab's "dialog" always returns a screenshot and a project PDF.
      return {
        ...insert(state, 'lab-screenshot.png', LAB_SCREENSHOT_PNG),
        files: [{ name: 'lab-spec.pdf', reference: '@docs/lab-spec.pdf', inProject: true }],
      };
    case 'paste': {
      trustedProject(state, command.workspaceId);
      if (command.name.length > 1024) throw workspaceFailure('INVALID_ARGUMENT');
      const name = displayName(command.name, 'Pasted image');
      if (command.data.length > Math.ceil(MAX_LAB_IMAGE_BYTES / 3) * 4) return attachments({ rejected: [{ name, reason: 'too-large' }] });
      return insert(state, name, command.data);
    }
    case 'drop':
      if (!isUuid(command.dropId)) throw workspaceFailure('INVALID_ARGUMENT');
      trustedProject(state, command.workspaceId);
      // The browser lab never observes an OS drop; every id is unknown.
      throw workspaceFailure('DROP_EXPIRED');
    case 'preview': {
      if (!isUuid(command.attachmentId)) throw workspaceFailure('INVALID_ARGUMENT');
      const item = store.get(command.attachmentId);
      if (item === undefined || !item.pending) throw workspaceFailure('ATTACHMENT_UNAVAILABLE');
      return { type: 'preview', protocol: 1, attachmentId: command.attachmentId, mimeType: item.image.mimeType, data: item.data };
    }
    case 'discard':
      if (command.attachmentIds.length > MAX_PENDING || !command.attachmentIds.every(isUuid)) throw workspaceFailure('INVALID_ARGUMENT');
      for (const id of command.attachmentIds) if (store.get(id)?.pending) store.delete(id);
      return { type: 'discarded', protocol: 1 };
    case 'files': {
      trustedProject(state, command.workspaceId);
      if ([...command.query].length > 256 || /[\u0000-\u001f\u007f]/u.test(command.query)) throw workspaceFailure('INVALID_ARGUMENT');
      const needle = command.query.trim().replace(/^@+/, '').replace(/\s+/g, '').replaceAll('\\', '/').toLowerCase();
      const files = LAB_PROJECT_FILES.filter((path) => matches(needle, path));
      return {
        type: 'files',
        protocol: 1,
        workspaceId: command.workspaceId,
        query: command.query,
        files: files.slice(0, MAX_LAB_FILES),
        truncated: files.length > MAX_LAB_FILES,
      };
    }
    case 'catalog': {
      if (!isUuid(command.sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
      const record = authorizeLive(state, command.sessionId);
      if (record.runId !== undefined) throw workspaceFailure('NOT_SUPPORTED');
      requireLive(record);
      return { type: 'catalog', protocol: 1, sessionId: command.sessionId, ...labComposerCatalog(record.harness) };
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function composerInputsHandlers(runtime: LabSessions): LabHandlers {
  return {
    workspace_composer_inputs_v1: (args) =>
      composerInputs(runtime, decodeArgument<ComposerInputsCommand>(args, 'command', composerInputsCommandSchema)),
  };
}

/** The pending image of `id` (lab tests only). */
export function labPendingImage(state: LabState, id: string): ComposerImage | undefined {
  const item = attachmentStore(state).get(id);
  return item?.pending ? item.image : undefined;
}

/** Whether the lab still holds the bytes of `id` (lab tests only). */
export function labHoldsImage(state: LabState, id: string): boolean {
  return attachmentStore(state).has(id);
}
