<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import { t } from '../../features/locale/language';
  import { Button, Field, Switch } from '../../lib/ui';
  import { attention, type AttentionSettings as Settings, type AttentionStore } from '../attention/attention.svelte';
  import { playSound as playPreset, SOUND_IDS, type SoundId } from '../attention/sounds';

  interface Props {
    /** Test seams; the settings page uses the application's attention store and sounds. */
    store?: AttentionStore;
    play?: (id: SoundId, volume: number) => Promise<boolean>;
  }
  let { store = attention, play = playPreset }: Props = $props();
  const uid = $props.id();

  const settings = $derived(store.settings);

  const SOUND_NAMES: Readonly<Record<SoundId, string>> = { chime: 'Chime', bell: 'Bell', pop: 'Pop', marimba: 'Marimba' };

  const toggles: readonly { key: keyof Pick<Settings, 'sound' | 'badge' | 'flash'>; label: string }[] = [
    { key: 'sound', label: 'Play a sound' },
    { key: 'badge', label: 'Show a number on the taskbar button' },
    { key: 'flash', label: 'Flash the taskbar button' },
  ];
  const events: readonly { key: keyof Pick<Settings, 'onFinished' | 'onDecision' | 'onFailed'>; label: string }[] = [
    { key: 'onFinished', label: 'A chat finishes its turn' },
    { key: 'onDecision', label: 'A chat needs an approval or an answer' },
    { key: 'onFailed', label: 'A chat fails' },
  ];

  function chooseSound(event: Event & { currentTarget: HTMLSelectElement }): void {
    const id = event.currentTarget.value as SoundId;
    if (!SOUND_IDS.includes(id)) return;
    store.update({ soundId: id });
    void play(id, settings.volume);
  }

  function chooseVolume(event: Event & { currentTarget: HTMLInputElement }): void {
    store.update({ volume: event.currentTarget.valueAsNumber / 100 });
  }
</script>

<h2>{$t('Notifications')}</h2>

<div class="rows">
  {#each toggles as toggle (toggle.key)}
    <div class="row">
      <span>{$t(toggle.label)}</span>
      <Switch label={$t(toggle.label)} hideLabel checked={settings[toggle.key]} onCheckedChange={(value) => store.update({ [toggle.key]: value } as Partial<Settings>)} />
    </div>
  {/each}
</div>

<div class="form">
  <Field label={$t('Sound')} for={`${uid}-sound`}>
    <div class="inline">
      <select id={`${uid}-sound`} class="select" value={settings.soundId} disabled={!settings.sound} onchange={chooseSound}>
        {#each SOUND_IDS as id (id)}
          <option value={id}>{$t(SOUND_NAMES[id])}</option>
        {/each}
      </select>
      <Button size="md" disabled={!settings.sound} onclick={() => void play(settings.soundId, settings.volume)}>
        {#snippet leading()}<Play size={14} aria-hidden="true" />{/snippet}
        {$t('Play')}
      </Button>
    </div>
  </Field>
  <Field label={$t('Volume')} for={`${uid}-volume`}>
    <input
      id={`${uid}-volume`}
      class="range"
      type="range"
      min="0"
      max="100"
      step="5"
      value={Math.round(settings.volume * 100)}
      disabled={!settings.sound}
      onchange={chooseVolume}
      oninput={chooseVolume}
    />
  </Field>
</div>

<h3 id={`${uid}-events`}>{$t('Notify me when')}</h3>
<div class="rows" role="group" aria-labelledby={`${uid}-events`}>
  {#each events as item (item.key)}
    <div class="row">
      <span>{$t(item.label)}</span>
      <Switch label={$t(item.label)} hideLabel checked={settings[item.key]} onCheckedChange={(value) => store.update({ [item.key]: value } as Partial<Settings>)} />
    </div>
  {/each}
</div>

<style>
  h2 {
    margin: 0 0 var(--piui-space-4);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    margin: var(--piui-space-5) 0 var(--piui-space-2);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .rows {
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-4);
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row + .row {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .form {
    display: grid;
    gap: var(--piui-space-3);
    max-width: 31rem;
    margin-top: var(--piui-space-4);
  }
  .inline {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
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
  .select:focus-visible,
  .range:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }
  .select:disabled,
  .range:disabled {
    opacity: 0.5;
  }
  .range {
    width: 100%;
    accent-color: var(--piui-accent);
  }
</style>
