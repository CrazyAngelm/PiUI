<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Dialog } from '../../lib/ui';
  import MarkChoices from './MarkChoices.svelte';

  interface Props {
    target: { kind: 'project' | 'session'; id: string };
    onClose: () => void;
  }
  let { target, onClose }: Props = $props();
</script>

<Dialog
  open
  title={$t('Mark')}
  size="sm"
  closeLabel={$t('Close')}
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <MarkChoices {target} {onClose} />
</Dialog>
