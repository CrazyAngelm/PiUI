import type { DictationSettingsUpdateV1, DictationSettingsV1 } from '../../host-api/dictationClient';
import type { DictationSource } from './dictationSource.svelte';

/** What the text fields of the Dictation settings hold while they are typed in. */
export interface DictationDraft {
  openaiModel: string;
  groqModel: string;
  customModel: string;
  customBaseUrl: string;
  /** The language hint as typed; empty means none. */
  language: string;
}

export type DictationDraftField = keyof DictationDraft;

const FIELDS: readonly DictationDraftField[] = ['openaiModel', 'groqModel', 'customModel', 'customBaseUrl', 'language'];

/** The drafts a view of the host's settings stands for. */
export function draftFromHost(host: DictationSettingsV1 | undefined): DictationDraft {
  const provider = (id: 'openai' | 'groq' | 'custom') => host?.providers.find((candidate) => candidate.id === id);
  return {
    openaiModel: provider('openai')?.model ?? '',
    groqModel: provider('groq')?.model ?? '',
    customModel: provider('custom')?.model ?? '',
    customBaseUrl: provider('custom')?.baseUrl ?? '',
    language: host?.language ?? '',
  };
}

/** What the host last saved, as an update. */
export function savedUpdate(host: DictationSettingsV1): DictationSettingsUpdateV1 {
  const draft = draftFromHost(host);
  return {
    source: host.source,
    language: host.language,
    openaiModel: draft.openaiModel,
    groqModel: draft.groqModel,
    customBaseUrl: draft.customBaseUrl,
    customModel: draft.customModel,
  };
}

/**
 * The text fields of the Dictation settings. A draft starts from the host's settings and then
 * belongs to the person typing: a reply to an older save never replaces what was typed after
 * that save was sent. A refused save keeps the draft so it can be corrected.
 */
export class DictationDrafts implements DictationDraft {
  openaiModel = $state('');
  groqModel = $state('');
  customModel = $state('');
  customBaseUrl = $state('');
  language = $state('');
  private adopted = false;

  constructor(private readonly source: Pick<DictationSource, 'settings' | 'save'>) {
    this.adopt();
  }

  /** Takes the host's values once, when its settings first arrive. */
  adopt(): void {
    const host = this.source.settings;
    if (host === undefined || this.adopted) return;
    this.adopted = true;
    const next = draftFromHost(host);
    for (const field of FIELDS) this[field] = next[field];
  }

  /**
   * Saves the named fields with the values they hold now, on top of what the host saved before
   * this turn. When the host answers, a field takes the host's (cleaned) value only if it still
   * holds what was sent.
   */
  save(...fields: DictationDraftField[]): Promise<boolean> {
    const sent: Partial<DictationDraft> = {};
    for (const field of fields) sent[field] = this[field];
    return this.source
      .save((host) => (host === undefined ? undefined : { ...savedUpdate(host), ...changes(sent) }))
      .then((done) => {
        const host = this.source.settings;
        if (!done || host === undefined) return done;
        const next = draftFromHost(host);
        for (const field of fields) if (this[field] === sent[field]) this[field] = next[field];
        return done;
      });
  }
}

/** The update fields a set of sent drafts stands for. */
function changes(sent: Partial<DictationDraft>): Partial<DictationSettingsUpdateV1> {
  const update: Partial<DictationSettingsUpdateV1> = {};
  if (sent.openaiModel !== undefined) update.openaiModel = sent.openaiModel;
  if (sent.groqModel !== undefined) update.groqModel = sent.groqModel;
  if (sent.customModel !== undefined) update.customModel = sent.customModel;
  if (sent.customBaseUrl !== undefined) update.customBaseUrl = sent.customBaseUrl;
  if (sent.language !== undefined) update.language = sent.language.trim() === '' ? null : sent.language.trim();
  return update;
}
