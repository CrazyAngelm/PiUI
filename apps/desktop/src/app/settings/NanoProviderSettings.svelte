<script lang="ts">
  import { onMount } from 'svelte';
  import { language, t } from '../../features/locale/language';
  import { forgetHarnessCatalogs } from '../../host-api/harnessModels';
  import { NANO_CHATGPT_ERRORS, NANO_PROVIDER_ERRORS, nanoChatGpt, nanoProviders } from '../../host-api/nanoProviders';
  import { Button, Dialog, Field, Input, Skeleton } from '../../lib/ui';
  import type { NanoExternalProviderRequestFormatV1, NanoProvidersErrorCodeV1, NanoProvidersRequestV1, NanoProvidersResultV1 } from '../../../../../contracts/nano-providers-v1';
  import type { NanoChatGptErrorCodeV1, NanoChatGptRequestV1, NanoChatGptResultV1 } from '../../../../../contracts/nano-chatgpt-v1';

  /**
   * The Nano harness's model sources (ChatGPT plan and OpenAI-compatible
   * APIs). They live in Settings → Harnesses → Nano → Connect, not in the
   * Nano account: they are not part of signing in to Nano.
   */
  const formatLabels: Record<NanoExternalProviderRequestFormatV1, string> = {
    compatible: 'Compatible (max_tokens)',
    openai: 'OpenAI (max_completion_tokens)',
  };

  /** The model sources changed: reload the harness catalogs. */
  let { onChange }: { onChange: () => void } = $props();
  const uid = $props.id();
  const titleId = `${uid}-providers`;
  const chatgptTitleId = `${uid}-chatgpt`;
  const nameId = `${uid}-name`;
  const urlId = `${uid}-url`;
  const modelFieldId = `${uid}-model`;
  const formatId = `${uid}-format`;

  let result = $state<NanoProvidersResultV1>();
  let busy = $state(false);
  let error = $state('');
  let name = $state('');
  let baseUrl = $state('');
  let modelId = $state('');
  let requestFormat = $state<NanoExternalProviderRequestFormatV1>('compatible');
  let chatgpt = $state<NanoChatGptResultV1>();
  let chatgptBusy = $state<NanoChatGptRequestV1['type']>();
  let chatgptError = $state('');
  let chatgptWelcome = $state(false);

  onMount(() => {
    void run({ type: 'list' });
    void runChatGpt({ type: 'status' });
  });

  async function runChatGpt(request: NanoChatGptRequestV1): Promise<void> {
    if (request.type !== 'cancel') chatgptBusy = request.type;
    chatgptError = '';
    try {
      const firstSignIn = chatgpt?.status.registered === false;
      chatgpt = await nanoChatGpt(request);
      if (request.type === 'connect' && firstSignIn) chatgptWelcome = true;
      if (request.type === 'disconnect') {
        chatgptWelcome = false;
        if (chatgpt.remoteRevocationConfirmed === false) {
          chatgptError = 'Signed out on this device. Check ChatGPT settings to confirm that access was revoked.';
        }
      }
      if (request.type === 'connect' || request.type === 'disconnect') {
        forgetHarnessCatalogs('nano');
        onChange();
      }
    } catch (reason: unknown) {
      const code = typeof reason === 'object' && reason && 'code' in reason ? reason.code : undefined;
      if (code !== 'chat-gpt-cancelled') {
        chatgptError = typeof code === 'string' && Object.hasOwn(NANO_CHATGPT_ERRORS, code)
          ? NANO_CHATGPT_ERRORS[code as NanoChatGptErrorCodeV1]
          : NANO_CHATGPT_ERRORS.storage;
      }
    } finally {
      if (request.type !== 'cancel') chatgptBusy = undefined;
    }
  }

  async function run(request: NanoProvidersRequestV1): Promise<void> {
    busy = true;
    error = '';
    try {
      const previous = result?.providers.length;
      const next = await nanoProviders(request);
      result = next;
      if (request.type !== 'list' && previous !== next.providers.length) {
        forgetHarnessCatalogs('nano');
        onChange();
        if (request.type === 'connect') {
          name = baseUrl = modelId = '';
          requestFormat = 'compatible';
        }
      }
    } catch (reason: unknown) {
      const code = typeof reason === 'object' && reason && 'code' in reason ? reason.code : undefined;
      error = typeof code === 'string' && Object.hasOwn(NANO_PROVIDER_ERRORS, code)
        ? NANO_PROVIDER_ERRORS[code as NanoProvidersErrorCodeV1]
        : NANO_PROVIDER_ERRORS.storage;
    } finally {
      busy = false;
    }
  }
</script>

<section class="providers" aria-labelledby={titleId}>
  <h3 id={titleId}>{$t('External model providers')}</h3>
  {#if error}<p class="provider-error" role="alert">{$t(error)}</p>{/if}
  {#if !result && busy}
    <Skeleton lines={2} />
  {:else if result?.supported}
    {#if chatgpt?.supported || chatgptError}
      <section class="block" aria-labelledby={chatgptTitleId}>
        <h4 id={chatgptTitleId}>{$t('Use your ChatGPT plan')}</h4>
        <p class="detail">{$t('Eligible requests to ChatGPT models use your ChatGPT plan or credits.')}</p>
        {#if chatgptError}<p class="provider-error" role="alert">{$t(chatgptError)}</p>{/if}
        {#if chatgpt?.status.connected}
          {#if chatgpt.status.email}<p class="email">{chatgpt.status.email}</p>{/if}
          {#if chatgpt.status.credentialStore === 'memory'}
            <p class="detail">{$t('This ChatGPT connection lasts until you close Nano Desktop.')}</p>
          {/if}
          <div class="actions">
            <Button size="sm" variant="ghost" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'manage-usage' })}>{$t('Manage usage')}</Button>
            <Button size="sm" variant="ghost" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'disconnect' })}>{$t('Disconnect ChatGPT')}</Button>
          </div>
        {:else if chatgptBusy === 'connect'}
          <p class="detail" role="status">{$t('Finish signing in to ChatGPT in your browser.')}</p>
          <div class="actions">
            <Button size="sm" variant="ghost" onclick={() => void runChatGpt({ type: 'cancel' })}>{$t('Cancel')}</Button>
          </div>
        {:else if chatgpt?.supported}
          <div class="actions">
            <Button variant="primary" data-oai-siwc-button="" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'connect' })}>{$t('Continue with ChatGPT')}</Button>
          </div>
        {:else if chatgptError}
          <div class="actions">
            <Button size="sm" variant="ghost" onclick={() => void runChatGpt({ type: 'status' })}>{$t('Retry')}</Button>
          </div>
        {/if}
      </section>
    {/if}
    {#if result.providers.length}
      <ul class="connections">
        {#each result.providers as provider (provider.id)}
          <li>
            <div class="connection">
              <strong>{provider.spec.name}</strong>
              <span class="detail">{provider.spec.modelId} · {provider.spec.baseUrl} · {$t(formatLabels[provider.spec.requestFormat ?? 'compatible'])}</span>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={$t('Disconnect {0}', [provider.spec.name])}
              onclick={() => void run({ type: 'disconnect', id: provider.id })}>{$t('Disconnect')}</Button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="block">
      <p class="detail">{$t('Add a model from an OpenAI-compatible API. Enter its key in the Windows dialog.')}</p>
      <form onsubmit={(event) => {
        event.preventDefault();
        void run({ type: 'connect', language: $language, spec: { name: name.trim(), baseUrl: baseUrl.trim(), modelId: modelId.trim(), requestFormat } });
      }}>
        <Field label={$t('Provider name')} for={nameId}>
          <Input id={nameId} bind:value={name} required disabled={busy} />
        </Field>
        <Field label={$t('API base URL')} for={urlId}>
          <Input id={urlId} bind:value={baseUrl} type="url" placeholder="https://api.example.com/v1" required disabled={busy} />
        </Field>
        <Field label={$t('Model ID')} for={modelFieldId}>
          <Input id={modelFieldId} bind:value={modelId} required disabled={busy} />
        </Field>
        <Field label={$t('Chat Completions request format')} for={formatId}>
          <select id={formatId} bind:value={requestFormat} disabled={busy}>
            <option value="compatible">{$t(formatLabels.compatible)}</option>
            <option value="openai">{$t(formatLabels.openai)}</option>
          </select>
        </Field>
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !baseUrl.trim() || !modelId.trim()}>
          {$t('Connect API key…')}
        </Button>
      </form>
    </div>
  {:else if result}
    <p class="detail">{$t(NANO_PROVIDER_ERRORS.unsupported)}</p>
  {:else if error}
    <Button size="sm" variant="ghost" onclick={() => void run({ type: 'list' })}>{$t('Retry')}</Button>
  {/if}
</section>

<Dialog bind:open={chatgptWelcome} title={$t('You’re using your ChatGPT plan')}
  description={$t('Choose a ChatGPT model in Nano. You can manage plan usage in ChatGPT settings.')}
  closeLabel={$t('Close')} size="sm">
  {#snippet footer()}
    <Button variant="primary" onclick={() => { chatgptWelcome = false; }}>{$t('Got it')}</Button>
  {/snippet}
</Dialog>

<style>
  .providers {
    display: grid;
    gap: var(--piui-space-4);
  }
  h3 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  h4 {
    margin: 0;
    font-size: inherit;
    font-weight: var(--piui-weight-semibold);
  }
  p {
    margin: 0;
  }
  .block {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-4);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  form {
    display: grid;
    gap: var(--piui-space-3);
    max-width: 31rem;
  }
  form :global(button[type='submit']) {
    justify-self: start;
  }
  select {
    height: var(--piui-control-md);
    padding: 0 var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font: inherit;
  }
  select:hover {
    border-color: var(--piui-border-strong);
  }
  select:focus-visible {
    outline: none;
    border-color: var(--piui-focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-focus) 18%, transparent);
  }
  .connections {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .connections li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    padding-block: var(--piui-space-2);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .connection {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .email {
    overflow-wrap: anywhere;
  }
  .detail {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
    overflow-wrap: anywhere;
  }
  .provider-error {
    color: var(--piui-danger-text);
  }
</style>
