<script lang="ts" module>
  /** A teammate color is a `#rrggbb` value or the name of a `--piui-*` token. */
  export function teammateColor(color: string): string {
    if (/^#[0-9a-f]{6}$/iu.test(color)) return color;
    if (/^[a-z][a-z0-9-]{0,40}$/u.test(color)) return `var(--piui-${color})`;
    return 'var(--piui-chaos)';
  }
</script>

<script lang="ts">
  interface Props {
    avatar: string;
    color: string;
    /** Accessible name; the avatar is decorative when absent. */
    label?: string;
    size?: number;
  }
  import { isEmojiAvatar } from './handle';

  let { avatar, color, label, size = 20 }: Props = $props();
  const emoji = $derived(isEmojiAvatar(avatar));
</script>

<span
  class="avatar"
  class:avatar--emoji={emoji}
  style:--avatar-color={teammateColor(color)}
  style:width="{size}px"
  style:height="{size}px"
  style:border-radius="{Math.max(4, Math.round(size * 0.28))}px"
  style:font-size="{Math.round(size * (emoji ? 0.6 : 0.42))}px"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>{avatar}</span>

<style>
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    overflow: hidden;
    background:
      linear-gradient(145deg, color-mix(in srgb, var(--avatar-color) 46%, transparent), color-mix(in srgb, var(--avatar-color) 16%, transparent)),
      var(--piui-surface-2);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--avatar-color) 60%, transparent);
    color: color-mix(in srgb, var(--avatar-color) 30%, var(--piui-text));
    font-weight: var(--piui-weight-semibold);
    letter-spacing: -0.02em;
    line-height: 1;
    user-select: none;
  }
  .avatar--emoji {
    background:
      radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--avatar-color) 34%, transparent), color-mix(in srgb, var(--avatar-color) 10%, transparent) 72%),
      var(--piui-surface-2);
    font-weight: normal;
  }
</style>
