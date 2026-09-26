<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Checkbox } from '../../lib/ui';

  /** One labelled choice per secret-like environment name; names only, never values. */
  interface Props {
    names: readonly string[];
    allowed: string[];
  }
  let { names, allowed = $bindable() }: Props = $props();

  function toggle(name: string, checked: boolean): void {
    allowed = checked ? [...new Set([...allowed, name])] : allowed.filter((item) => item !== name);
  }
</script>

<fieldset>
  <legend>{$t('Pass to the agent')}</legend>
  {#each names as name (name)}
    <Checkbox label={name} checked={allowed.includes(name)} onCheckedChange={(checked) => toggle(name, checked)} />
  {/each}
</fieldset>

<style>
  fieldset {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
