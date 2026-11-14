<script lang="ts">
  import { untrack } from 'svelte';
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { attachComposer, type ComposerHandle, type ComposerOptions } from '../../shared/composer/composer';
  import '../../shared/composer/composer.css';
  import Textarea from './Textarea.svelte';

  interface Props extends Omit<HTMLTextareaAttributes, 'onkeydown'> {
    value?: string;
    ref?: HTMLTextAreaElement | null;
    minRows: number;
    maxRows: number;
    beforeKeyDown?: (event: KeyboardEvent) => void;
    onSubmit: (event: KeyboardEvent) => void;
  }

  let { value = $bindable(''), ref = $bindable(null), minRows, maxRows, beforeKeyDown, onSubmit, ...rest }: Props = $props();
  let behavior = $state.raw<ComposerHandle | undefined>();
  const options = (): ComposerOptions => ({ contractVersion: 1, autoGrow: { minRows, maxRows }, beforeKeyDown, onSubmit });

  $effect(() => {
    const input = ref;
    if (!input) return;
    const current = untrack(() => attachComposer(input, options()));
    behavior = current;
    return () => { current.dispose(); behavior = undefined; };
  });

  $effect(() => {
    // Owner-driven changes (dictation, mentions, send acknowledgement) resize
    // after Svelte patches the original textarea. No draft copy is maintained.
    void value;
    behavior?.update(options());
  });
</script>

<Textarea bind:ref bind:value {minRows} {maxRows} autoGrow={false} unstyled data-nano-composer="editor" {...rest} />
