<script lang="ts" generics="T extends string">
  import { Command } from 'bits-ui';
  import { onMount, type Snippet } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Search from '@lucide/svelte/icons/search';
  import type { PickerItem } from './Picker.svelte';

  interface Props {
    groups: [string, PickerItem<T>[]][];
    value: T | undefined;
    label: string;
    searchPlaceholder: string;
    emptyText: string;
    header: Snippet<[{ focusSearch: () => void }]> | undefined;
    footer: Snippet | undefined;
    search: string;
    searchField: HTMLInputElement | null;
    focusSearch: () => void;
    headerKeydown: (event: KeyboardEvent) => void;
    onSearchKeydown: ((event: KeyboardEvent) => void) | undefined;
    onChoose: (item: PickerItem<T>) => void;
  }
  let { groups, value, label, searchPlaceholder, emptyText, header, footer,
    search = $bindable(''), searchField = $bindable(null), focusSearch,
    headerKeydown, onSearchKeydown, onChoose }: Props = $props();

  // A cold chunk arrives after the popover's initial autofocus event.
  onMount(() => searchField?.focus());
</script>

      <Command.Root label={label} loop>
        <div class="piui-picker__search">
          <Search size={14} />
          <Command.Input
            bind:ref={searchField}
            bind:value={search}
            class="piui-picker__input"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onkeydown={onSearchKeydown}
          />
        </div>
        {#if header}
          <!-- svelte-ignore a11y_no_static_element_interactions (Only keeps Enter on a header control from reaching the list; the controls are the keyboard targets.) -->
          <div class="piui-picker__header" onkeydown={headerKeydown}>{@render header({ focusSearch })}</div>
        {/if}
        <Command.List class="piui-picker__list">
          <Command.Viewport>
            <Command.Empty class="piui-picker__empty">{emptyText}</Command.Empty>
            {#each groups as [group, groupItems] (group)}
              <Command.Group>
                {#if group}<Command.GroupHeading class="piui-picker__heading">{group}</Command.GroupHeading>{/if}
                <Command.GroupItems>
                  {#each groupItems as item (item.value)}
                    <Command.Item
                      class="piui-picker__item"
                      value={`${item.group ?? ''}\u0000${item.value}`}
                      keywords={[item.label, item.value, ...(item.keywords ?? [])]}
                      disabled={item.disabled}
                      onSelect={() => onChoose(item)}
                    >
                      <span class="piui-picker__check">
                        {#if item.value === value}<Check size={14} />{/if}
                      </span>
                      <span class="piui-picker__main">
                        <span class="piui-picker__label">{item.label}</span>
                        {#if item.disabled && item.disabledReason}
                          <span class="piui-picker__desc">{item.disabledReason}</span>
                        {:else if item.description}
                          <span class="piui-picker__desc">{item.description}</span>
                        {/if}
                      </span>
                      {#each item.badges ?? [] as badge (badge)}
                        <span class="piui-picker__badge">{badge}</span>
                      {/each}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
      {#if footer}<div class="piui-picker__footer">{@render footer()}</div>{/if}
