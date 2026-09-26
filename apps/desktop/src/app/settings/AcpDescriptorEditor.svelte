<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Checkbox, Field, Input, Segmented, Textarea } from '../../lib/ui';
  import type { AcpDescriptorForm } from './acpAgents';

  /** ACP agent descriptor v1 as a labelled form or as JSON (never a shell string). */
  type Mode = 'form' | 'json';
  interface Props {
    mode: Mode;
    form: AcpDescriptorForm;
    json: string;
    onModeChange: (mode: Mode) => void;
  }
  let { mode = $bindable(), form = $bindable(), json = $bindable(), onModeChange }: Props = $props();
  const uid = $props.id();
  const id = (field: string): string => `${uid}-${field}`;
  const optional = $derived($t('optional'));
</script>

<div class="editor">
  <Segmented
    label={$t('Descriptor input')}
    bind:value={mode}
    options={[{ value: 'form', label: $t('Form') }, { value: 'json', label: $t('JSON') }]}
    onValueChange={(value: Mode) => onModeChange(value)}
  />
  {#if mode === 'form'}
    <div class="grid">
      <Field label={$t('Agent ID')} for={id('id')} description={$t('Lowercase letters, digits and hyphens, for example qwen-code. Chats and pipelines use it as acp:<ID>.')}>
        <Input id={id('id')} bind:value={form.id} autocomplete="off" spellcheck="false" required />
      </Field>
      <Field label={$t('Name')} for={id('name')}>
        <Input id={id('name')} bind:value={form.displayName} autocomplete="off" required />
      </Field>
    </div>
    <Field label={$t('Program')} for={id('program')} description={$t('A program name found on PATH or an absolute path. PiUI never uses a shell.')}>
      <Input id={id('program')} bind:value={form.program} autocomplete="off" spellcheck="false" required />
    </Field>
    <Field label={$t('Arguments')} for={id('args')} optionalLabel={optional} description={$t('One argument per line, for example --experimental-acp.')}>
      <Textarea id={id('args')} bind:value={form.args} minRows={2} maxRows={6} spellcheck="false" />
    </Field>
    <div class="grid">
      <Field label={$t('Version arguments')} for={id('version-args')} description={$t('One per line; the program prints its version with them.')}>
        <Textarea id={id('version-args')} bind:value={form.versionArgs} minRows={1} maxRows={4} spellcheck="false" />
      </Field>
      <Field label={$t('Version pattern')} for={id('version-pattern')} optionalLabel={optional} description={$t('A regular expression whose first group is the version.')}>
        <Input id={id('version-pattern')} bind:value={form.versionPattern} autocomplete="off" spellcheck="false" />
      </Field>
    </div>
    <div class="grid">
      <Field label={$t('Tested from version')} for={id('minimum')} optionalLabel={optional} description={$t('MAJOR.MINOR.PATCH, included.')}>
        <Input id={id('minimum')} bind:value={form.verifiedMinimum} placeholder="1.0.0" autocomplete="off" />
      </Field>
      <Field label={$t('Tested below version')} for={id('ceiling')} optionalLabel={optional} description={$t('MAJOR.MINOR.PATCH, excluded. Other versions need your confirmation.')}>
        <Input id={id('ceiling')} bind:value={form.verifiedCeiling} placeholder="2.0.0" autocomplete="off" />
      </Field>
    </div>
    <Field label={$t('Environment variables')} for={id('environment')} optionalLabel={optional} description={$t('Names only, one per line. Values stay in your environment; names such as API keys pass only after you allow them.')}>
      <Textarea id={id('environment')} bind:value={form.environment} minRows={2} maxRows={6} spellcheck="false" />
    </Field>
    <Field label={$t('Sign-in hint')} for={id('hint')} optionalLabel={optional} description={$t('How to sign in with the agent’s own app. Never paste a key or token here.')}>
      <Textarea id={id('hint')} bind:value={form.authHint} minRows={2} maxRows={4} />
    </Field>
    <Field label={$t('Documentation link')} for={id('docs')} optionalLabel={optional}>
      <Input id={id('docs')} type="url" bind:value={form.docsUrl} placeholder="https://" autocomplete="off" />
    </Field>
    <fieldset class="switches">
      <legend>{$t('Switch off agent features')}</legend>
      <Checkbox label={$t('Reopening chats')} description={$t('Never reload a conversation with session/load.')} bind:checked={form.noLoadSession} />
      <Checkbox label={$t('Model choice')} description={$t('Ignore the models the agent advertises.')} bind:checked={form.noModels} />
      <Checkbox label={$t('Session modes')} description={$t('Ignore the modes the agent advertises.')} bind:checked={form.noModes} />
      <Checkbox label={$t('PiUI coordination tool')} description={$t('Never offer PiUI’s workspace tool as an HTTP MCP server.')} bind:checked={form.noMcpHttp} />
    </fieldset>
  {:else}
    <Field label={$t('Descriptor JSON')} for={id('json')} description={$t('ACP agent descriptor v1. Unknown fields are rejected, never dropped.')}>
      <Textarea id={id('json')} bind:value={json} minRows={12} maxRows={24} spellcheck="false" class="json" />
    </Field>
  {/if}
</div>

<style>
  .editor {
    display: grid;
    gap: var(--piui-space-4);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--piui-space-4);
  }
  .switches {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--piui-space-2);
    font-weight: var(--piui-weight-medium);
  }
  .editor :global(.json) {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
</style>
