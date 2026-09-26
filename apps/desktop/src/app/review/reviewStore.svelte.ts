import type {
  ReviewArea,
  ReviewDiffV1,
  ReviewFileV1,
  ReviewRequestV1,
  ReviewResultV1,
  ReviewStatusV1,
} from '../../../../../contracts/workspace-review-v1';
import { changedPaths, fileKey } from './review';

export type ReviewRequester = (request: ReviewRequestV1) => Promise<ReviewResultV1>;

async function hostRequester(request: ReviewRequestV1): Promise<ReviewResultV1> {
  const { reviewHost } = await import('../../host-api/reviewClient');
  return reviewHost.request(request);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}

/** The last listed changed paths per chat, for the handoff draft. */
const lastChangedPaths = new Map<string, string[]>();

export function reviewedPaths(sessionId: string): string[] | undefined {
  return lastChangedPaths.get(sessionId);
}

export type ReviewAction = 'stage' | 'unstage' | 'revert';

/**
 * State of one chat's review panel: the folder status, the selected file's
 * diff and the running action. Every action repeats the fingerprint of the
 * diff on screen; a `STALE` refusal reloads it so the person sees the
 * current change before trying again.
 */
export class ReviewStore {
  status = $state.raw<ReviewStatusV1 | undefined>();
  loading = $state(false);
  error = $state('');
  errorCode = $state('');
  selected = $state.raw<{ path: string; area: ReviewArea } | undefined>();
  diff = $state.raw<ReviewDiffV1 | undefined>();
  diffLoading = $state(false);
  diffError = $state('');
  /** `action:hunk` of the running action, empty when idle. */
  busy = $state('');
  actionError = $state('');
  private statusRequest = 0;
  private diffRequest = 0;

  constructor(
    readonly sessionId: string,
    private readonly request: ReviewRequester = hostRequester,
  ) {}

  get files(): ReviewFileV1[] {
    return this.status?.files ?? [];
  }

  get readOnly(): boolean {
    return this.status?.readOnly ?? false;
  }

  async refresh(): Promise<void> {
    const ticket = ++this.statusRequest;
    this.loading = this.status === undefined;
    try {
      const result = await this.request({ type: 'status', sessionId: this.sessionId });
      if (ticket !== this.statusRequest || result.type !== 'status') return;
      this.applyStatus(result);
      this.error = '';
      this.errorCode = '';
    } catch (error) {
      if (ticket !== this.statusRequest) return;
      this.error = message(error);
      this.errorCode = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
    } finally {
      if (ticket === this.statusRequest) this.loading = false;
    }
  }

  private applyStatus(status: ReviewStatusV1): void {
    this.status = status;
    lastChangedPaths.set(this.sessionId, changedPaths(status.files));
    const selected = this.selected;
    const still = selected !== undefined && status.files.some((file) => fileKey(file) === fileKey(selected));
    if (!still) {
      const first = status.files[0];
      this.selected = first === undefined ? undefined : { path: first.path, area: first.area };
    }
    void this.loadDiff();
  }

  select(file: { path: string; area: ReviewArea }): void {
    this.selected = { path: file.path, area: file.area };
    this.actionError = '';
    void this.loadDiff();
  }

  async loadDiff(): Promise<void> {
    const selected = this.selected;
    const ticket = ++this.diffRequest;
    if (selected === undefined) {
      this.diff = undefined;
      this.diffLoading = false;
      return;
    }
    this.diffLoading = true;
    this.diffError = '';
    try {
      const result = await this.request({ type: 'diff', sessionId: this.sessionId, path: selected.path, area: selected.area });
      if (ticket !== this.diffRequest || result.type !== 'diff') return;
      this.diff = result;
    } catch (error) {
      if (ticket !== this.diffRequest) return;
      this.diff = undefined;
      this.diffError = message(error);
    } finally {
      if (ticket === this.diffRequest) this.diffLoading = false;
    }
  }

  /** Runs an action on the shown diff (or one of its hunks). */
  async act(action: ReviewAction, hunk: number | undefined = undefined): Promise<boolean> {
    const diff = this.diff;
    if (diff === undefined || this.busy) return false;
    this.busy = `${action}:${hunk ?? 'file'}`;
    this.actionError = '';
    const base = { sessionId: this.sessionId, path: diff.path, fingerprint: diff.fingerprint, ...(hunk === undefined ? {} : { hunk }) };
    const area = diff.area === 'untracked' ? 'untracked' : 'unstaged';
    let request: ReviewRequestV1;
    switch (action) {
      case 'unstage':
        request = { type: 'unstage', ...base };
        break;
      case 'stage':
        request = { type: 'stage', area, ...base };
        break;
      case 'revert':
        request = { type: 'revert', area, ...base };
        break;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
    try {
      const result = await this.request(request);
      if (result.type === 'status') this.applyStatus(result);
      return true;
    } catch (error) {
      this.actionError = message(error);
      if ((error as { code?: unknown }).code === 'STALE') {
        await this.refresh();
      }
      return false;
    } finally {
      this.busy = '';
    }
  }
}
