<script lang="ts">
  import { untrack } from 'svelte';
  import type { PluginValue } from '../../../../../contracts/piui-plugin-v1';
  import type { PluginEntryV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';
  import { resolvePluginValues } from '../../host-api/pluginManifest';
  import { pluginsError } from '../../host-api/pluginsClient';
  import { Button, Dialog } from '../../lib/ui';
  import PluginFieldsForm from './PluginFieldsForm.svelte';
  import { pluginRegistry } from './pluginRegistry.svelte';

  /** A plugin's declarative settings, rendered and stored by PiUI. */
  interface Props {
    open: boolean;
    plugin: PluginEntryV1;
  }
  let { open = $bindable(), plugin }: Props = $props();

  let values = $state<Record<string, PluginValue>>(untrack(() => ({ ...plugin.settings })));
  let busy = $state(false);
  let error = $state('');
  const check = $derived(resolvePluginValues(plugin.contributes.settings, values));

  function change(key: string, value: PluginValue | undefined): void {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    values = next;
  }

  async function save(): Promise<void> {
    if (busy || !check.ok) return;
    busy = true;
    error = '';
    try {
      await pluginRegistry.run({ type: 'setSettings', expectedRevision: pluginRegistry.revision, id: plugin.id, values, origin: 'settings' });
      open = false;
    } catch (cause) {
      const failure = pluginsError(cause);
      const problem = failure.problems[0];
      error = problem ? $t(problem.message, [problem.subject ?? '']) : $t(failure.message);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title={$t('{0} settings', [plugin.name])} description={$t('PiUI stores these values and passes them to the plugin. Do not put passwords or API keys here.')} closeLabel={$t('Close')}>
  <form
    class="form"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <PluginFieldsForm fields={plugin.contributes.settings} {values} idPrefix="plugin-settings-{plugin.id}" disabled={busy} onChange={change} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="primary" loading={busy} disabled={!check.ok} onclick={() => void save()}>{$t('Save')}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: var(--piui-space-4);
  }
  .error {
    margin: 0;
    color: var(--piui-danger-text);
  }
</style>
