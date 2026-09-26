<script lang="ts" module>
  export interface FlowApi {
    fitView: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    center: (x: number, y: number) => void;
    toFlow: (screen: { x: number; y: number }) => { x: number; y: number };
    viewportCenter: () => { x: number; y: number };
  }
</script>

<script lang="ts">
  import { useSvelteFlow } from '@xyflow/svelte';
  import { onMount } from 'svelte';

  interface Props {
    container: HTMLElement | null;
    onready: (api: FlowApi) => void;
  }
  let { container, onready }: Props = $props();
  const flow = useSvelteFlow();

  onMount(() => {
    onready({
      fitView: () => void flow.fitView({ padding: 0.2, duration: 200, maxZoom: 1.1 }),
      zoomIn: () => void flow.zoomIn({ duration: 150 }),
      zoomOut: () => void flow.zoomOut({ duration: 150 }),
      center: (x, y) => void flow.setCenter(x, y, { zoom: Math.max(flow.getZoom(), 0.9), duration: 250 }),
      toFlow: (screen) => flow.screenToFlowPosition(screen),
      viewportCenter: () => {
        const box = container?.getBoundingClientRect();
        return box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
      },
    });
  });
</script>
