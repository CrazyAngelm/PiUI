<script lang="ts" module>
  export interface FlowApi {
    fitView: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    center: (x: number, y: number) => void;
    toFlow: (screen: { x: number; y: number }) => { x: number; y: number };
    viewportCenter: () => { x: number; y: number };
    /** Makes one card the whole selection, like clicking it: a marquee selection and the selection frame go away. */
    select: (nodeId: string) => void;
  }
</script>

<script lang="ts">
  import { useStore, useSvelteFlow } from '@xyflow/svelte';
  import { onMount } from 'svelte';

  interface Props {
    container: HTMLElement | null;
    onready: (api: FlowApi) => void;
  }
  let { container, onready }: Props = $props();
  const flow = useSvelteFlow();
  const store = useStore();

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
      select: (nodeId) => {
        // What Svelte Flow does for a click on a card, minus the click.
        store.selectionRect = null;
        store.selectionRectMode = null;
        store.unselectNodesAndEdges();
        store.addSelectedNodes([nodeId]);
      },
    });
  });
</script>
