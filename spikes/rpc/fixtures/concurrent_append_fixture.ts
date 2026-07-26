import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Startup-lifecycle append used only by the synthetic SPIKE-06 race. */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const tag = process.env.PIUI_SPIKE_CONCURRENT_TAG;
    if (tag === "writer-a" || tag === "writer-b") {
      pi.appendEntry("piui-spike-concurrent", { tag, version: 1 });
    }
  });
}
