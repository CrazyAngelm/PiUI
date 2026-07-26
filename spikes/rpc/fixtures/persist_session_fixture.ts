import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Harness-owned persistence command: append a safe custom entry without an LLM turn. */
export default function (pi: ExtensionAPI): void {
  pi.registerCommand("piui-persist-synthetic", {
    description: "Persist only a PiUI synthetic SPIKE-01 custom entry.",
    handler: async () => {
      pi.appendEntry("piui-spike-persistence", { fixture: "synthetic", version: 1 });
    },
  });
}
