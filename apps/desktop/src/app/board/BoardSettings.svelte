<script lang="ts">
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import { t } from '../../features/locale/language';
  import { Button, Checkbox, Popover, Segmented, toasts } from '../../lib/ui';
  import { DEFAULT_BOARD_SETTINGS, type BoardAgentModeV1, type BoardSettingsV1 } from '../../host-api/boardClient';
  import { errorMessage } from '../workspaceStore.svelte';
  import type { BoardStore } from './boardStore.svelte';
  import { PERMISSION_COPY } from './boardModel';

  interface Props {
    board: BoardStore;
  }
  let { board }: Props = $props();

  let open = $state(false);
  let draft = $state<BoardSettingsV1>(structuredClone(DEFAULT_BOARD_SETTINGS));
  let busy = $state(false);


  function reset(next: boolean): void {
    if (next && board.board) draft = structuredClone($state.snapshot(board.board.settings));
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      await board.updateSettings($state.snapshot(draft));
      toasts.success($t('Board settings saved'));
      open = false;
    } catch (error) {
      toasts.error($t('Could not save the board settings'), $t(errorMessage(error)));
    } finally {
      busy = false;
    }
  }

  async function turnOff(): Promise<void> {
    busy = true;
    try {
      await board.setEnabled(false);
      open = false;
    } catch (error) {
      toasts.error($t('Could not turn off the board'), $t(errorMessage(error)));
    } finally {
      busy = false;
    }
  }
</script>

<Popover bind:open width={340} align="end" label={$t('Board settings')} onOpenChange={reset}>
  {#snippet trigger(props)}
    <button type="button" class="trigger" aria-label={$t('Board settings')} title={$t('Board settings')} {...props}><Settings2 size={16} /></button>
  {/snippet}
  <div class="settings">
    <span class="streak" aria-hidden="true"></span>
    <h2>{$t('Board settings')}</h2>
    <div class="group" role="group" aria-labelledby="board-agent-mode">
      <span id="board-agent-mode" class="group__label">{$t('Agent changes')}</span>
      <Segmented
        value={draft.agentMode}
        label={$t('Agent changes')}
        size="sm"
        options={[
          { value: 'auto', label: $t('Apply, undo later') },
          { value: 'proposal', label: $t('Ask me first') },
        ]}
        onValueChange={(value: BoardAgentModeV1) => (draft.agentMode = value)}
      />
      <p class="note">
        {draft.agentMode === 'auto'
          ? $t('Agents change cards at once; every change can be undone from the card.')
          : $t('Agent changes wait in the Inbox for Accept or Reject.')}
      </p>
    </div>
    <fieldset class="group">
      <legend class="group__label">{$t('Agents in chats of this project may')}</legend>
      {#each PERMISSION_COPY as permission (permission.key)}
        <Checkbox
          label={$t(permission.label)}
          description={$t(permission.description)}
          checked={draft.chatAgentPermissions[permission.key]}
          onCheckedChange={(checked) => (draft.chatAgentPermissions[permission.key] = checked)}
        />
      {/each}
    </fieldset>
    <div class="group">
      <label class="group__label" for="board-max-runs">{$t('Runs at the same time')}</label>
      <input
        id="board-max-runs"
        class="number"
        type="number"
        min="1"
        max="16"
        value={draft.maxConcurrentRuns}
        oninput={(event) => {
          const value = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isFinite(value)) draft.maxConcurrentRuns = Math.min(16, Math.max(1, value));
        }}
      />
      <p class="note">{$t('A safety ceiling across all teammates of this board.')}</p>
    </div>
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={() => void turnOff()} disabled={busy}>{$t('Turn off board')}</Button>
      <Button size="sm" variant="primary" onclick={() => void save()} loading={busy}>{$t('Save')}</Button>
    </div>
    <p class="note">{$t('Turning the board off keeps every card; agents stop getting the board tool.')}</p>
  </div>
</Popover>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
  }
  .trigger:hover,
  .trigger[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .settings {
    position: relative;
    display: grid;
    gap: var(--piui-space-3);
  }
  .streak {
    position: absolute;
    top: calc(-1 * var(--piui-space-3));
    left: calc(-1 * var(--piui-space-3));
    width: 62%;
    height: 2px;
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold) 55%, transparent);
    clip-path: polygon(0 0, 100% 0, 96% 100%, 0 100%);
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .group {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .group__label {
    padding: 0;
    color: var(--piui-chaos);
    font-size: 10px;
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .note {
    margin: 0;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .number {
    width: 80px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .actions {
    display: flex;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
</style>
