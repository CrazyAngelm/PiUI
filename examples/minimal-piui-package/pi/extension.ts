import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Backend half of the package. It works in ordinary Pi even when PiUI is not
 * installed, because all agent behavior is registered through Pi itself.
 */
export default function projectHealthExtension(pi: ExtensionAPI): void {
  pi.registerCommand("project-health-refresh", {
    description: "Append a simple project-health entry to the current session",
    handler: async (_args, ctx) => {
      const recordedAt = new Date().toISOString();
      const payload = {
        status: "ok",
        projectName: ctx.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ctx.cwd,
        recordedAt,
      };

      pi.appendEntry("example.project-health", payload);
      ctx.ui.notify(`Project health recorded at ${recordedAt}`, "info");
    },
  });
}
