<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { language, t } from '../../features/locale/language';
  import type { DictationProviderIdV1, DictationSettingsUpdateV1, DictationSettingsV1, DictationSourceV1 } from '../../host-api/dictationClient';
  import { Button, Field, Input, Skeleton } from '../../lib/ui';
  import { DICTATION_MODEL_SUGGESTIONS, DICTATION_SOURCE_ERROR_COPY } from '../nano/dictationCopy';
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

  const providerOf = (id: DictationProviderIdV1) => source.settings?.providers.find((provider) => provider.id === id);
  const fromHost = () => ({
    openaiModel: providerOf('openai')?.model ?? '',
    groqModel: providerOf('groq')?.model ?? '',
    customModel: providerOf('custom')?.model ?? '',
    customBaseUrl: providerOf('custom')?.baseUrl ?? '',
    languageCode: source.settings?.language ?? '',
  });
  // Drafts start from the host's values. A draft follows the host only when the host's value for
  // that field changed, so a refused save keeps what was typed and a save in flight never erases
  // the field being typed in.
  let seen = untrack(fromHost);
  let openaiModel = $state(seen.openaiModel);
  let groqModel = $state(seen.groqModel);
  let customModel = $state(seen.customModel);
  let customBaseUrl = $state(seen.customBaseUrl);
  let languageCode = $state(seen.languageCode);

  $effect(() => {
    if (source.settings === undefined) return;
    untrack(() => {
      const next = fromHost();
      if (next.openaiModel !== seen.openaiModel) openaiModel = next.openaiModel;
      if (next.groqModel !== seen.groqModel) groqModel = next.groqModel;
      if (next.customModel !== seen.customModel) customModel = next.customModel;
      if (next.customBaseUrl !== seen.customBaseUrl) customBaseUrl = next.customBaseUrl;
      if (next.languageCode !== seen.languageCode) languageCode = next.languageCode;
      seen = next;
    });
  });

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

  /** What the host last saved, as an update. */
  const savedUpdate = (host: DictationSettingsV1): DictationSettingsUpdateV1 => ({
    source: host.source,
    language: host.language,
    openaiModel: host.providers.find((provider) => provider.id === 'openai')?.model ?? '',
    groqModel: host.providers.find((provider) => provider.id === 'groq')?.model ?? '',
    customBaseUrl: host.providers.find((provider) => provider.id === 'custom')?.baseUrl ?? '',
    customModel: host.providers.find((provider) => provider.id === 'custom')?.model ?? '',
  });

  /** Saves the changed fields on top of what the host last saved, so a refused field never blocks another. */
  function update(fields: Partial<DictationSettingsUpdateV1>): Promise<boolean> {
    return source.save((host) => (host === undefined ? undefined : { ...savedUpdate(host), ...fields }));
  }

  const hint = (): string | null => (languageCode.trim() === '' ? null : languageCode.trim());

  function chooseSource(event: Event & { currentTarget: HTMLSelectElement }): void {
    const select = event.currentTarget;
    void update({ source: select.value as DictationSourceV1 }).then((done) => {
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
  <p class="lead">{$t('Choose what turns your speech into text in the message box. A recording goes only to the service you choose and is not kept.')}</p>
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
            bind:value={customBaseUrl}
            type="url"
            placeholder="https://api.example.com/v1"
            invalid={urlError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void update({ customBaseUrl })}
          />
        </Field>
      {/if}
      <Field label={$t('Model')} for={`${uid}-model`} error={modelError}>
        {#if provider === 'openai'}
          <Input
            id={`${uid}-model`}
            bind:value={openaiModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void update({ openaiModel })}
          />
        {:else if provider === 'groq'}
          <Input
            id={`${uid}-model`}
            bind:value={groqModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void update({ groqModel })}
          />
        {:else}
          <Input
            id={`${uid}-model`}
            bind:value={customModel}
            list={`${uid}-models`}
            invalid={modelError !== undefined}
            autocomplete="off"
            spellcheck={false}
            onchange={() => void update({ customModel })}
          />
        {/if}
        <datalist id={`${uid}-models`}>
          {#each DICTATION_MODEL_SUGGESTIONS[provider] as name (name)}<option value={name}></option>{/each}
        </datalist>
      </Field>
      <Field label={$t('Spoken language')} for={`${uid}-language`} optionalLabel={$t('optional')} error={languageError}>
        <Input
          id={`${uid}-language`}
          bind:value={languageCode}
          placeholder="en"
          maxlength={3}
          invalid={languageError !== undefined}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          onchange={() => void update({ language: hint() })}
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
