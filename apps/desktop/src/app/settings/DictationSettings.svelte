<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { language, t } from '../../features/locale/language';
  import type { DictationSourceV1 } from '../../host-api/dictationClient';
  import { Button, Field, Input, Skeleton } from '../../lib/ui';
  import { DICTATION_MODEL_SUGGESTIONS, DICTATION_SOURCE_ERROR_COPY } from '../nano/dictationCopy';
  import { DictationDrafts, savedUpdate } from '../nano/dictationDrafts.svelte';
  import { dictationSource as sharedSource, type DictationSource } from '../nano/dictationSource.svelte';
  import { nanoAccount as sharedAccount } from '../nano/nanoAccount.svelte';

  interface Props {
    /** Safe mode: no recording is sent anywhere, so nothing can be set up. */
    safeMode: boolean;
    /** Test seams; the settings page uses the application's dictation source and account. */
    source?: DictationSource;
    account?: { readonly canDictate: boolean };
  }
  let { safeMode, source = sharedSource, account = sharedAccount }: Props = $props();
  const uid = $props.id();

  const settings = $derived(source.settings);
  // The provider the chosen source uses (none for off and Nano).
  const current = $derived(settings?.providers.find((provider) => provider.id === settings.source));
  const canSetKey = $derived(current !== undefined && current.baseUrl !== '' && current.model !== '');

  // The text fields start from the host's values; a reply to a save never replaces what was typed after it.
  const drafts = untrack(() => new DictationDrafts(source));
  $effect(() => drafts.adopt());

  onMount(() => {
    void source.start();
  });

  const code = $derived(source.error);
  const urlError = $derived(current?.id === 'custom' && code === 'invalid-url' ? $t(DICTATION_SOURCE_ERROR_COPY[code]) : undefined);
  const modelError = $derived(current !== undefined && code === 'invalid-model' ? $t(DICTATION_SOURCE_ERROR_COPY[code]) : undefined);
  const languageError = $derived(current !== undefined && code === 'invalid-language' ? $t(DICTATION_SOURCE_ERROR_COPY[code]) : undefined);
  // Any failure that no field shows.
  const notice = $derived(
    code !== undefined && urlError === undefined && modelError === undefined && languageError === undefined
      ? DICTATION_SOURCE_ERROR_COPY[code]
      : undefined,
  );

  function chooseSource(event: Event & { currentTarget: HTMLSelectElement }): void {
    const select = event.currentTarget;
    const chosen = select.value as DictationSourceV1;
    // The change goes on top of what the host last saved, so a refused text field never blocks it.
    void source.save((host) => (host === undefined ? undefined : { ...savedUpdate(host), source: chosen })).then((done) => {
      // A refused change snaps the select back to the source the host kept.
      if (!done) select.value = source.settings?.source ?? 'nano';
    });
  }
</script>

<h2>{$t('Dictation')}</h2>

{#if safeMode || settings?.safeMode}
  <p class="lead">{$t('Safe mode is on: dictation is off.')}</p>
{:else if settings === undefined}
  <div class="loading" aria-busy="true"><Skeleton lines={3} /></div>
{:else}
  <p class="lead">{$t('Choose what turns your speech into text in the message box. A recording goes only to the service you choose. One that could not be sent stays on this computer for up to 24 hours, until you send, save or delete it.')}</p>
  {#if notice}<p class="notice" role="alert">{$t(notice)}</p>{/if}
  <div class="form">
    <Field label={$t('Speech to text')} for={`${uid}-source`}>
      <select id={`${uid}-source`} class="select" value={settings.source} disabled={source.busy} onchange={chooseSource}>
        <option value="off">{$t('Off')}</option>
        {#if account.canDictate || settings.source === 'nano'}
          <option value="nano">{account.canDictate ? $t('Nano subscription') : $t('Nano subscription (sign in required)')}</option>
        {/if}
        <option value="openai">OpenAI</option>
        <option value="groq">Groq</option>
        <option value="custom">{$t('Custom API')}</option>
      </select>
    </Field>

    {#if current}
      {@const provider = current.id}
      {#if provider === 'custom'}
        <Field label={$t('API base URL')} for={`${uid}-url`} error={urlError}>
          <Input
            id={`${uid}-url`}
            bind:value={drafts.customBaseUrl}
            type="url"
            placeholder="https://api.example.com/v1"
            invalid={urlError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void drafts.save('customBaseUrl')}
          />
        </Field>
      {/if}
      <Field label={$t('Model')} for={`${uid}-model`} error={modelError}>
        {#if provider === 'openai'}
          <Input
            id={`${uid}-model`}
            bind:value={drafts.openaiModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void drafts.save('openaiModel')}
          />
        {:else if provider === 'groq'}
          <Input
            id={`${uid}-model`}
            bind:value={drafts.groqModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void drafts.save('groqModel')}
          />
        {:else}
          <Input
            id={`${uid}-model`}
            bind:value={drafts.customModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void drafts.save('customModel')}
          />
        {/if}
        <datalist id={`${uid}-models`}>
          {#each DICTATION_MODEL_SUGGESTIONS[provider] as name (name)}<option value={name}></option>{/each}
        </datalist>
      </Field>
      <Field label={$t('Spoken language')} for={`${uid}-language`} optionalLabel={$t('optional')} error={languageError}>
        <Input
          id={`${uid}-language`}
          bind:value={drafts.language}
          placeholder="en"
          maxlength={3}
          invalid={languageError !== undefined}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          onchange={() => void drafts.save('language')}
        />
      </Field>
      <div class="key" role="group" aria-labelledby={`${uid}-key`}>
        <strong id={`${uid}-key`}>{$t('API key')}{#if !current.keyRequired} <span class="optional">{$t('optional')}</span>{/if}</strong>
        <span class="detail" role="status">{current.keySet ? $t('Saved in the system credential store') : $t('Not set')}</span>
        {#if settings.keyEntry}
          <div class="actions">
            <Button size="sm" disabled={source.busy || !canSetKey} onclick={() => void source.setKey(provider, $language)}>
              {current.keySet ? $t('Replace API key…') : $t('Set API key…')}
            </Button>
            {#if current.keySet}
              <Button size="sm" variant="ghost" disabled={source.busy} onclick={() => void source.clearKey(provider)}>{$t('Remove API key')}</Button>
            {/if}
          </div>
        {:else}
          <p class="detail">{$t('API keys can be entered only on Windows in this version.')}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  h2 {
    margin: 0 0 var(--piui-space-4);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .lead {
    margin: 0 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .loading {
    padding: var(--piui-space-2) 0;
  }
  .notice {
    margin: 0 0 var(--piui-space-4);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .form {
    display: grid;
    gap: var(--piui-space-3);
    max-width: 31rem;
  }
  .select {
    min-width: 180px;
    height: var(--piui-control-md);
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .select:disabled {
    opacity: 0.5;
  }
  .key {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .optional,
  .detail {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-regular);
  }
</style>
