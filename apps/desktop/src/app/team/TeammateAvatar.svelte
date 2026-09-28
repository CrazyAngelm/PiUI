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
  let { avatar, color, label, size = 20 }: Props = $props();
</script>

<span
  class="avatar"
  style:--avatar-color={teammateColor(color)}
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.48)}px"
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
    border-radius: 6px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--avatar-color) 38%, transparent), color-mix(in srgb, var(--avatar-color) 14%, transparent)),
      var(--piui-surface-2);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--avatar-color) 55%, transparent);
    color: var(--piui-text);
    font-weight: var(--piui-weight-semibold);
    line-height: 1;
    clip-path: polygon(12% 0, 100% 0, 88% 100%, 0 100%);
    user-select: none;
  }
</style>
