<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import ChatComposer from '../src/app/chat/ChatComposer.svelte';
  import type { SessionSnapshot } from '../src/host-api/workspaceClient';

  let { snapshot, updateDraft }: { snapshot: SessionSnapshot; updateDraft: (text: string) => void } = $props();
</script>

<Tooltip.Provider>
  <ChatComposer {snapshot} draft="" {updateDraft} refresh={() => undefined} interrupt={async () => false} />
</Tooltip.Provider>
