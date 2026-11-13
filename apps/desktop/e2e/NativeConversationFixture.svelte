<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import Transcript from '../src/app/chat/transcript/Transcript.svelte';
  import type { Readable } from 'svelte/store';
  import type { TimelineBlock } from '../src/host-api/types';
  let { blocks }: { blocks: Readable<TimelineBlock[]> } = $props();
</script>

<Tooltip.Provider>
  <Transcript blocks={$blocks} loading={false} sessionKey="synthetic-native-webview-proof" agentLabel="Native fixture" />
</Tooltip.Provider>
