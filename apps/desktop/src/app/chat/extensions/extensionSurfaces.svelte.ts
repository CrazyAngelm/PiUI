import {
  applyEditorSuggestion,
  discardEditorSuggestion,
  dismissExtensionNotification,
  emptyExtensionUiViewState,
  reduceExtensionUiState,
  type ExtensionUiViewState,
} from '../../../features/runtime/extensionUiState';
import { extensionUiHost, type ExtensionUiClient, type WorkspaceExtensionUiEventV1 } from '../../../host-api/extensionUiClient';

/** Access to the per-chat composer drafts the workspace store keeps. */
export interface DraftAccess {
  draftFor(sessionId: string): string;
  updateDraft(sessionId: string, text: string): void;
}

const EMPTY: ExtensionUiViewState = emptyExtensionUiViewState();

/**
 * Per-session extension UI surfaces (notices, statuses, widgets, the window
 * title and prepared composer text), reduced with the same rules the classic
 * view used. State is in memory only: a restart or a stopped runtime clears
 * it, and an extension re-sends what it still wants to show.
 *
 * Prepared composer text never replaces a draft the user typed: an empty
 * composer receives it directly, otherwise it waits as a suggestion. A draft
 * change bumps the session's composer epoch so the chat remounts its composer
 * with the new text.
 */
export class ExtensionSurfaces {
  states = $state.raw<Record<string, ExtensionUiViewState>>({});
  composerEpochs = $state.raw<Record<string, number>>({});
  private drafts: DraftAccess | undefined;

  stateFor(sessionId: string): ExtensionUiViewState {
    return this.states[sessionId] ?? EMPTY;
  }

  composerEpoch(sessionId: string): number {
    return this.composerEpochs[sessionId] ?? 0;
  }

  /** Subscribes once; returns the unsubscribe function. */
  async start(drafts: DraftAccess, client: ExtensionUiClient = extensionUiHost): Promise<() => void> {
    this.drafts = drafts;
    return client.listen((event) => this.apply(event));
  }

  apply(event: WorkspaceExtensionUiEventV1): void {
    const sessionId = event.sessionId;
    const draft = this.drafts?.draftFor(sessionId) ?? '';
    const reduction = reduceExtensionUiState(this.stateFor(sessionId), event.action, draft);
    this.set(sessionId, reduction.state);
    if (reduction.draft !== draft) this.replaceDraft(sessionId, reduction.draft);
  }

  /**
   * Text a plugin command or a composer action prepared (ADR-032): the same
   * rule as `set_editor_text`, so it is always reviewed before sending.
   */
  prepareText(sessionId: string, text: string): void {
    const draft = this.drafts?.draftFor(sessionId) ?? '';
    const reduction = reduceExtensionUiState(this.stateFor(sessionId), { action: 'editorText', text }, draft);
    this.set(sessionId, reduction.state);
    if (reduction.draft !== draft) this.replaceDraft(sessionId, reduction.draft);
  }

  dismissNotice(sessionId: string, noticeId: string): void {
    this.set(sessionId, dismissExtensionNotification(this.stateFor(sessionId), noticeId));
  }

  acceptSuggestion(sessionId: string): void {
    const reduction = applyEditorSuggestion(this.stateFor(sessionId));
    this.set(sessionId, reduction.state);
    this.replaceDraft(sessionId, reduction.draft);
  }

  discardSuggestion(sessionId: string): void {
    this.set(sessionId, discardEditorSuggestion(this.stateFor(sessionId)));
  }

  /** A stopped or failed runtime no longer owns its extension surfaces. */
  clear(sessionId: string): void {
    if (!(sessionId in this.states)) return;
    const { [sessionId]: _cleared, ...rest } = this.states;
    this.states = rest;
  }

  private set(sessionId: string, state: ExtensionUiViewState): void {
    this.states = { ...this.states, [sessionId]: state };
  }

  private replaceDraft(sessionId: string, text: string): void {
    this.drafts?.updateDraft(sessionId, text);
    this.composerEpochs = { ...this.composerEpochs, [sessionId]: this.composerEpoch(sessionId) + 1 };
  }
}

export const extensionSurfaces = new ExtensionSurfaces();
