<script lang="ts">
  import { onMount } from 'svelte';
  import { language, t } from '../../features/locale/language';
  import { forgetHarnessCatalogs } from '../../host-api/harnessModels';
  import { NANO_CHATGPT_ERRORS, NANO_PROVIDER_ERRORS, nanoChatGpt, nanoProviders } from '../../host-api/nanoProviders';
  import { Button, Dialog, Skeleton } from '../../lib/ui';
  import type { NanoExternalProviderRequestFormatV1, NanoProvidersErrorCodeV1, NanoProvidersRequestV1, NanoProvidersResultV1 } from '../../../../../contracts/nano-providers-v1';
  import type { NanoChatGptErrorCodeV1, NanoChatGptRequestV1, NanoChatGptResultV1 } from '../../../../../contracts/nano-chatgpt-v1';

  const formatLabels: Record<NanoExternalProviderRequestFormatV1, string> = {
    compatible: 'Compatible (max_tokens)',
    openai: 'OpenAI (max_completion_tokens)',
  };

  let { onChange }: { onChange: () => void } = $props();
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

<section class="providers" aria-labelledby="external-providers-title">
  <h2 id="external-providers-title">{$t('External model providers')}</h2>
  {#if error}<p class="provider-error" role="alert">{$t(error)}</p>{/if}
  {#if !result && busy}
    <Skeleton lines={2} />
  {:else if result?.supported}
    {#if chatgpt?.supported || chatgptError}
      <section class="chatgpt" aria-labelledby="chatgpt-provider-title">
        <h3 id="chatgpt-provider-title">{$t('Use your ChatGPT plan')}</h3>
        <p class="detail">{$t('Eligible requests to ChatGPT models use your ChatGPT plan or credits.')}</p>
        {#if chatgptError}<p class="provider-error" role="alert">{$t(chatgptError)}</p>{/if}
        {#if chatgpt?.status.connected}
          {#if chatgpt.status.email}<p>{chatgpt.status.email}</p>{/if}
          {#if chatgpt.status.credentialStore === 'memory'}
            <p class="detail">{$t('This ChatGPT connection lasts until you close Nano Desktop.')}</p>
          {/if}
          <Button variant="ghost" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'manage-usage' })}>{$t('Manage usage')}</Button>
          <Button variant="ghost" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'disconnect' })}>{$t('Disconnect ChatGPT')}</Button>
        {:else if chatgptBusy === 'connect'}
          <p class="detail" role="status">{$t('Finish signing in to ChatGPT in your browser.')}</p>
          <Button variant="ghost" onclick={() => void runChatGpt({ type: 'cancel' })}>{$t('Cancel')}</Button>
        {:else if chatgpt?.supported}
          <Button variant="primary" data-oai-siwc-button="" disabled={!!chatgptBusy} onclick={() => void runChatGpt({ type: 'connect' })}>{$t('Continue with ChatGPT')}</Button>
        {:else if chatgptError}
          <Button variant="ghost" onclick={() => void runChatGpt({ type: 'status' })}>{$t('Retry')}</Button>
        {/if}
      </section>
    {/if}
    {#if result.providers.length}
      <ul class="connections">
        {#each result.providers as provider (provider.id)}
          <li>
            <div>
              <strong>{provider.spec.name}</strong>
              <div class="detail">{provider.spec.modelId} · {provider.spec.baseUrl} · {$t(formatLabels[provider.spec.requestFormat ?? 'compatible'])}</div>
            </div>
            <Button variant="ghost" disabled={busy} aria-label={$t('Disconnect {0}', [provider.spec.name])}
              onclick={() => void run({ type: 'disconnect', id: provider.id })}>{$t('Disconnect')}</Button>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="detail">{$t('Add a model from an OpenAI-compatible API. Enter its key in the Windows dialog.')}</p>
    <form onsubmit={(event) => {
      event.preventDefault();
      void run({ type: 'connect', language: $language, spec: { name: name.trim(), baseUrl: baseUrl.trim(), modelId: modelId.trim(), requestFormat } });
    }}>
      <label>{$t('Provider name')}<input bind:value={name} required disabled={busy} /></label>
      <label>{$t('API base URL')}<input bind:value={baseUrl} type="url" placeholder="https://api.example.com/v1" required disabled={busy} /></label>
      <label>{$t('Model ID')}<input bind:value={modelId} required disabled={busy} /></label>
      <label>{$t('Chat Completions request format')}
        <select bind:value={requestFormat} disabled={busy}>
          <option value="compatible">{$t(formatLabels.compatible)}</option>
          <option value="openai">{$t(formatLabels.openai)}</option>
        </select>
      </label>
      <Button variant="primary" type="submit" disabled={busy || !name.trim() || !baseUrl.trim() || !modelId.trim()}>
        {$t('Connect API key…')}
      </Button>
    </form>
  {:else if result}
    <p class="detail">{$t(NANO_PROVIDER_ERRORS.unsupported)}</p>
  {:else if error}
    <Button variant="ghost" onclick={() => void run({ type: 'list' })}>{$t('Retry')}</Button>
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
  .providers { margin-block-start: 2rem; }
  h2 { margin: 0 0 .75rem; font-size: 1rem; }
  h3 { margin: 0; font-size: .95rem; }
  .chatgpt { margin-block-end: 1rem; }
  form, label { display: grid; gap: .4rem; }
  form { gap: .75rem; max-inline-size: 31rem; }
  form :global(button) { justify-self: start; }
  input, select {
    min-inline-size: 0;
    padding: .55rem .65rem;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font: inherit;
  }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--piui-accent); outline-offset: 2px; }
  .connections { list-style: none; padding: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding-block: .5rem; }
  .detail { color: var(--piui-text-muted); overflow-wrap: anywhere; }
  .provider-error { color: var(--piui-danger); }
</style>
