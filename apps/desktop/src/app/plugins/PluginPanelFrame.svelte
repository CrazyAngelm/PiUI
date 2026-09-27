<script lang="ts">
  import { onMount } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { PLUGIN_PANEL_LIMITS, type PanelErrorCode, type PanelRendererActivity, type PanelTheme } from '../../../../../contracts/plugin-panel-v1';
  import type { PluginValue } from '../../../../../contracts/piui-plugin-v2';
  import type { PluginEntryV1 } from '../../../../../contracts/plugins-v1';
  import { language, t } from '../../features/locale/language';
  import {
    currentAppearance,
    envelope,
    methodPermitted,
    panelTheme,
    parsePanelMessage,
    rendererHeight,
    RequestBudget,
    type PanelInbound,
  } from '../../host-api/pluginBridge';
  import { pluginsError } from '../../host-api/pluginsClient';
  import { Button, Skeleton, toasts } from '../../lib/ui';
  import { runRegistryCommand } from './commands';
  import { pluginRegistry } from './pluginRegistry.svelte';

  /**
   * One plugin panel: the plugin's static page in a frame with
   * `sandbox="allow-scripts"` (an opaque origin: no same-origin access, top
   * navigation, forms, popups or downloads) served by the host with the
   * plugin's own restrictive CSP. Every message from the frame is untrusted:
   * it must come from this frame's window, carry this mount's channel, stay
   * within the size and rate limits, name a known method and pass the
   * plugin's permissions. A panel that never says `ready` is replaced with
   * a generic fallback.
   *
   * The same frame shows a chat renderer (plugins v2) when `activity` is
   * given: the tool activity goes out in `init` and as `activity` events,
   * `frame.resize` sets the height, and the parent shows the generic view
   * instead when `onStatus` reports `failed`.
   */
  interface Props {
    plugin: PluginEntryV1;
    /** A panel, or a renderer (its id and title). */
    panel: { id: string; title: string; url?: string };
    /** The open chat (sent only with `chat.read`). */
    chat: { id: string; title: string } | null;
    /** A renderer frame: the tool activity it shows. */
    activity?: PanelRendererActivity;
    onStatus?: (status: 'loading' | 'ready' | 'failed') => void;
  }
  let { plugin, panel, chat, activity, onStatus }: Props = $props();
  const renderer = $derived(activity !== undefined);
  let height = $state<number>(160);

  let frame = $state<HTMLIFrameElement | null>(null);
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let generation = $state(0);
  let channel = crypto.randomUUID();
  let budget = new RequestBudget();

  function post(message: object): void {
    // An opaque-origin frame can only be addressed with '*'; the message goes
    // to exactly this frame's window and carries no secret.
    frame?.contentWindow?.postMessage(envelope(message), '*');
  }

  function theme(): PanelTheme {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return panelTheme((name) => style.getPropertyValue(name), currentAppearance(root, window.matchMedia('(prefers-color-scheme: dark)').matches));
  }

  function refuse(id: string, code: PanelErrorCode, message: string): void {
    post({ type: 'response', channel, id, error: { code, message } });
  }

  function respond(id: string, result: unknown): void {
    post({ type: 'response', channel, id, result });
  }

  const context = () => ({ chat: plugin.permissions.includes('chat.read') ? chat : null });

  async function handle(request: Extract<PanelInbound, { kind: 'request' }>): Promise<void> {
    const { id, method } = request;
    if (!budget.allow()) return refuse(id, 'rate-limited', 'Too many requests.');
    if (!methodPermitted(method, plugin.permissions)) return refuse(id, 'permission-denied', 'The plugin does not have permission for this.');
    const params = (request.params ?? {}) as Record<string, unknown>;
    try {
      switch (method) {
        case 'context.get':
          return respond(id, context());
        case 'settings.get':
          return respond(id, pluginRegistry.plugin(plugin.id)?.settings ?? plugin.settings);
        case 'settings.set': {
          const response = await pluginRegistry.run({
            type: 'setSettings',
            expectedRevision: pluginRegistry.revision,
            id: plugin.id,
            values: params.values as Record<string, PluginValue>,
            origin: 'panel',
          });
          return respond(id, response.registry.plugins.find((item) => item.id === plugin.id)?.settings ?? {});
        }
        case 'commands.run': {
          const command = plugin.contributes.commands.find((item) => item.id === params.commandId);
          if (command === undefined) return refuse(id, 'failed', 'This plugin has no such command.');
          const outcome = await runRegistryCommand(
            { key: `plugin:${plugin.id}:${command.id}`, source: 'plugin', pluginId: plugin.id, pluginName: plugin.name, command },
            'panel',
            chat?.id,
            $t,
          );
          return outcome === undefined ? refuse(id, 'failed', 'The command failed.') : respond(id, outcome);
        }
        case 'notice.show': {
          const level = params.level;
          toasts.show({ tone: level === 'error' ? 'danger' : level === 'warning' ? 'warning' : 'neutral', title: plugin.name, description: String(params.message) });
          return respond(id, null);
        }
        case 'frame.resize':
          // Only a renderer frame follows its content; a panel keeps its size.
          if (renderer) height = rendererHeight(Number(params.height));
          return respond(id, null);
        default: {
          const exhaustive: never = method;
          return exhaustive;
        }
      }
    } catch (error) {
      refuse(id, 'failed', pluginsError(error).message);
    }
  }

  onMount(() => {
    const listener = (event: MessageEvent) => {
      if (frame === null || event.source !== frame.contentWindow) return;
      const inbound = parsePanelMessage(event.data, channel);
      switch (inbound.kind) {
        case 'ignore':
          return;
        case 'ready':
          status = 'ready';
          post({
            type: 'init',
            channel,
            plugin: { id: plugin.id, name: plugin.name },
            panel: { id: panel.id, title: panel.title },
            permissions: plugin.permissions,
            theme: theme(),
            locale: $language,
            ...(activity !== undefined ? { renderer: { id: panel.id, title: panel.title, activity } } : {}),
          });
          return;
        case 'refuse':
          return refuse(inbound.id, inbound.code, inbound.message);
        case 'request':
          void handle(inbound);
          return;
        default: {
          const exhaustive: never = inbound;
          return exhaustive;
        }
      }
    };
    window.addEventListener('message', listener);
    const observer = new MutationObserver(() => {
      if (status === 'ready') post({ type: 'event', channel, event: 'theme', data: theme() });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-plugin-theme'] });
    return () => {
      window.removeEventListener('message', listener);
      observer.disconnect();
    };
  });

  // A panel that does not answer is replaced with the generic fallback.
  $effect(() => {
    void generation;
    const timer = setTimeout(() => {
      if (status === 'loading') status = 'failed';
    }, PLUGIN_PANEL_LIMITS.readyTimeoutMs);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const current = context();
    if (status === 'ready' && plugin.permissions.includes('chat.read')) post({ type: 'event', channel, event: 'context', data: current });
  });

  // A streaming tool keeps its renderer up to date.
  $effect(() => {
    const current = activity;
    if (status === 'ready' && current !== undefined) post({ type: 'event', channel, event: 'activity', data: current });
  });

  $effect(() => {
    onStatus?.(status);
  });

  function reload(): void {
    channel = crypto.randomUUID();
    budget = new RequestBudget();
    status = 'loading';
    generation += 1;
  }
</script>

<div class="panel">
  {#if status === 'failed' && renderer}
    <!-- The parent shows the generic view instead. -->
  {:else if status === 'failed'}
    <div class="fallback" role="alert">
      <p>{$t('The panel “{0}” did not load. PiUI and your chat are not affected.', [panel.title])}</p>
      <Button size="sm" variant="ghost" onclick={reload}>
        {#snippet leading()}<RefreshCw />{/snippet}
        {$t('Reload panel')}
      </Button>
    </div>
  {:else}
    {#key generation}
      <iframe
        bind:this={frame}
        class:loading={status !== 'ready'}
        class:renderer
        style:height={renderer ? `${height}px` : undefined}
        src={panel.url}
        title={renderer ? $t('{0} (plugin view)', [panel.title]) : $t('{0} (plugin panel)', [panel.title])}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
      ></iframe>
    {/key}
    {#if status === 'loading'}<div class="skeleton"><Skeleton lines={2} /></div>{/if}
  {/if}
</div>

<style>
  .panel {
    position: relative;
    display: grid;
  }
  iframe {
    width: 100%;
    height: 240px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-raised);
  }
  /* Transparent, not `visibility: hidden`: a hidden frame is an invisible
     widget to the browser engine, which lowers the priority of its process
     and throttles it, so a loading panel can miss its ready deadline. */
  iframe.loading {
    opacity: 0;
    pointer-events: none;
  }
  .skeleton {
    position: absolute;
    inset: var(--piui-space-3);
  }
  .fallback {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .fallback p {
    margin: 0;
  }
</style>
