<script lang="ts">
  import { Command } from 'bits-ui';
  import { onMount, type Snippet } from 'svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import Heart from '@lucide/svelte/icons/heart';
  import Lock from '@lucide/svelte/icons/lock';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Search from '@lucide/svelte/icons/search';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { Segmented, Spinner } from '../../lib/ui';
  import { lockCopy } from '../nano/nanoView';
  import type { NanoModeV1 } from '../../../../../contracts/nano-account-v1';
  import type { ModelOption } from './ModelPicker.svelte';
  import { favoriteKey, type ModelTab } from './modelPickerView';

  interface Props {
    footer: Snippet;
    value: string;
    defaultOption: boolean;
    loading: boolean;
    error: string;
    search: string;
    searchInput: HTMLInputElement | null;
    shownTab: ModelTab;
    tabOptions: { value: ModelTab; label: string }[];
    emptyList: boolean;
    groups: [string, ModelOption[]][];
    favoriteSet: ReadonlySet<string>;
    signInRow: boolean;
    lockedModes: readonly NanoModeV1[];
    listKey: (event: KeyboardEvent) => void;
    changeTab: (tab: ModelTab) => void;
    toggleFavorite: (model: ModelOption) => void;
    heading: (group: string) => string;
    choose: (key: string, model: ModelOption | undefined) => void;
    openAccount: () => void;
  }
  let { value, defaultOption, loading, error, search = $bindable(''), searchInput = $bindable(null),
    shownTab, tabOptions, emptyList, groups, favoriteSet, signInRow, lockedModes,
    listKey, changeTab, toggleFavorite, heading, choose, openAccount, footer }: Props = $props();

  // A cold chunk arrives after the popover's initial autofocus event.
  onMount(() => searchInput?.focus());
</script>

      <span class="piui-models__streak" aria-hidden="true"></span>
      <Command.Root label={$t('Model')} loop onkeydown={listKey}>
        <div class="piui-models__search">
          <Search size={14} />
          <Command.Input class="piui-models__input" placeholder={$t('Search models')} aria-label={$t('Search models')} bind:value={search} bind:ref={searchInput} />
          {#if loading}<Spinner size={12} />{/if}
        </div>
        <div class="piui-models__tabs">
          <Segmented size="sm" label={$t('Models shown')} value={shownTab} options={tabOptions} onValueChange={changeTab} />
        </div>
        <Command.List class="piui-models__list">
          <Command.Viewport>
            <Command.Empty class="piui-models__empty">
              {error ? $t('Could not load models') : loading ? $t('Loading models…') : shownTab === 'favorites' ? $t('No favorites yet') : $t('No models found')}
            </Command.Empty>
            {#if shownTab === 'favorites' && defaultOption && emptyList && !loading && !error}
              <div class="piui-models__empty">{$t('No favorites yet')}</div>
            {/if}
            {#if defaultOption}
              <Command.Item
                class="piui-models__item"
                value={'\u0000default'}
                keywords={[$t('Harness default')]}
                data-current={value === '' ? '' : undefined}
                onSelect={() => choose('', undefined)}
              >
                <span class="piui-models__mark" aria-hidden="true"><Sparkles size={13} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{$t('Harness default')}</span>
                  <span class="piui-models__id piui-models__id--plain">{$t('Use the model configured in the harness')}</span>
                </span>
              </Command.Item>
            {/if}
            {#each groups as [group, items] (group)}
              {@const title = heading(group)}
              <Command.Group>
                {#if title}<Command.GroupHeading class="piui-models__heading"><span>{title}</span></Command.GroupHeading>{/if}
                <Command.GroupItems>
                  {#each items as model (model.key)}
                    {@const fav = favoriteSet.has(favoriteKey(model))}
                    <Command.Item
                      class="piui-models__item"
                      value={`${group}\u0000${model.key}`}
                      keywords={[model.name, model.id]}
                      data-current={model.key === value ? '' : undefined}
                      data-fav={favoriteKey(model)}
                      aria-keyshortcuts="Shift+Enter"
                      onSelect={() => choose(model.key, model)}
                    >
                      <span class="piui-models__mark" aria-hidden="true"></span>
                      <span class="piui-models__main">
                        <span class="piui-models__name">{model.name}</span>
                        <span class="piui-models__id">{model.id}</span>
                      </span>
                      <span class="piui-models__caps">
                        {#if model.reasoning}
                          <span class="piui-models__cap" title={$t('Supports reasoning levels')}>
                            <Brain size={12} aria-label={$t('reasoning')} />
                          </span>
                        {/if}
                        {#if model.fast}
                          <span class="piui-models__cap piui-models__cap--fast" title={$t('Supports fast mode')}>
                            <Zap size={12} aria-label={$t('fast')} />
                          </span>
                        {/if}
                      </span>
                      {#if fav}<span class="visually-hidden">, {$t('favorite')}</span>{/if}
                      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Presentational inside an option, which cannot hold a button; the keyboard path is Shift+Enter on the row.) -->
                      <span
                        class="piui-models__fav"
                        class:piui-models__fav--on={fav}
                        aria-hidden="true"
                        title={fav ? $t('Remove from favorites (Shift+Enter)') : $t('Add to favorites (Shift+Enter)')}
                        onmousedown={(event) => event.preventDefault()}
                        onclick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(model);
                        }}
                      >
                        <Heart size={14} fill={fav ? 'currentColor' : 'none'} />
                      </span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
            {#if signInRow}
              <Command.Item class="piui-models__item" value={'\u0000nano-sign-in'} keywords={[$t('Sign in to use Nano'), 'nano', 'account']} onSelect={openAccount}>
                <span class="piui-models__mark" aria-hidden="true"><LogIn size={13} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{$t('Sign in to use Nano')}</span>
                </span>
              </Command.Item>
            {/if}
            {#each lockedModes as mode (mode.id)}
              <Command.Item class="piui-models__item" value={`nano-locked\u0000${mode.id}`} keywords={[mode.name, mode.id]} disabled>
                <span class="piui-models__mark" aria-hidden="true"><Lock size={12} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{mode.name}</span>
                  <span class="piui-models__id piui-models__id--plain">{$t(lockCopy(mode) ?? 'Disabled')}</span>
                </span>
              </Command.Item>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>

      {@render footer()}
