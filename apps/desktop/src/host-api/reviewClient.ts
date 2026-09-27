import { hostInvoke, type HostInvoke } from './transport';
import type {
  ReviewArea,
  ReviewChange,
  ReviewContentV1,
  ReviewDiffV1,
  ReviewFileV1,
  ReviewRequestV1,
  ReviewResultV1,
  ReviewStatusV1,
} from '../../../../contracts/workspace-review-v1';
import { count, isRecord, optionalCount, optionalString, SessionToolError, sessionToolError } from './sessionToolErrors';

export type * from '../../../../contracts/workspace-review-v1';

/**
 * Client of `workspace_review_v1`: the git changes of a chat's folder. The
 * host is the authority for every rule (trust, safe mode, fingerprints);
 * this client only checks result shapes and maps refusals to safe copy.
 */
const AREAS: readonly ReviewArea[] = ['staged', 'unstaged', 'untracked'];
const CHANGES: readonly ReviewChange[] = ['modified', 'added', 'deleted', 'type-changed', 'intent-to-add', 'conflict', 'submodule'];

function isFile(value: unknown): value is ReviewFileV1 {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    AREAS.includes(value.area as ReviewArea) &&
    CHANGES.includes(value.change as ReviewChange) &&
    optionalCount(value.added) &&
    optionalCount(value.removed) &&
    (value.binary === undefined || value.binary === true) &&
    (value.renamedFrom === undefined || (typeof value.renamedFrom === 'string' && value.renamedFrom.length > 0))
  );
}

function isRepository(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.state === 'not-repository') return true;
  return (
    value.state === 'ready' &&
    optionalString(value.branch) &&
    optionalString(value.head) &&
    typeof value.worktree === 'boolean' &&
    typeof value.folder === 'string'
  );
}

function isContent(value: unknown): value is ReviewContentV1 {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'text':
      return typeof value.text === 'string' && count(value.hunks) && typeof value.hunkActions === 'boolean';
    case 'binary':
    case 'too-large':
      return optionalCount(value.size);
    case 'symlink':
    case 'submodule':
    case 'conflict':
      return true;
    default:
      return false;
  }
}

function decodeStatus(value: Record<string, unknown>): ReviewStatusV1 | undefined {
  const valid =
    typeof value.sessionId === 'string' &&
    isRepository(value.repository) &&
    Array.isArray(value.files) &&
    value.files.every(isFile) &&
    typeof value.truncated === 'boolean' &&
    count(value.hidden) &&
    typeof value.readOnly === 'boolean';
  return valid ? (value as unknown as ReviewStatusV1) : undefined;
}

function decodeDiff(value: Record<string, unknown>): ReviewDiffV1 | undefined {
  const actions = value.actions;
  const valid =
    typeof value.sessionId === 'string' &&
    typeof value.path === 'string' &&
    AREAS.includes(value.area as ReviewArea) &&
    typeof value.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    isContent(value.content) &&
    isRecord(actions) &&
    typeof actions.stage === 'boolean' &&
    typeof actions.unstage === 'boolean' &&
    typeof actions.revert === 'boolean';
  return valid ? (value as unknown as ReviewDiffV1) : undefined;
}

/** The result exactly as the contract describes it, or undefined. */
export function decodeReviewResult(value: unknown): ReviewResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  if (value.type === 'status') return decodeStatus(value);
  if (value.type === 'diff') return decodeDiff(value);
  return undefined;
}

export interface ReviewClient {
  request(request: ReviewRequestV1): Promise<ReviewResultV1>;
}

export function createReviewClient(invoke: HostInvoke): ReviewClient {
  return {
    async request(request) {
      let result: unknown;
      try {
        result = await invoke<unknown>('workspace_review_v1', { request });
      } catch (error) {
        throw sessionToolError(error);
      }
      const decoded = decodeReviewResult(result);
      if (decoded === undefined) throw new SessionToolError('unknown', 'The operation could not be completed.');
      return decoded;
    },
  };
}

export const reviewHost: ReviewClient = createReviewClient((command, args) => hostInvoke(command, args));
