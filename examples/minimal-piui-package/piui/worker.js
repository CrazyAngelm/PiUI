/**
 * Declarative PiUI worker. It never receives Tauri, Node, shell, or arbitrary
 * filesystem access. All operations go through the capability-limited context.
 */
export async function activate(ctx) {
  ctx.commands.register("openPanel", async () => {
    await ctx.ui.openView("example.project-health.panel", {
      column: "rightPanel",
      preserveFocus: false,
    });
  });

  ctx.ui.render("renderHealth", async ({ block }) => {
    const data = block?.content ?? {};
    const status = typeof data.status === "string" ? data.status : "unknown";
    const projectName = typeof data.projectName === "string" ? data.projectName : "Project";
    const recordedAt = typeof data.recordedAt === "string" ? data.recordedAt : "Unknown time";

    return {
      type: "column",
      gap: "sm",
      children: [
        {
          type: "row",
          gap: "sm",
          children: [
            { type: "badge", label: status, tone: status === "ok" ? "success" : "warning" },
            { type: "text", value: projectName },
          ],
        },
        { type: "text", value: `Recorded: ${recordedAt}`, tone: "muted", selectable: true },
      ],
    };
  });

  ctx.ui.render("renderPanel", async () => {
    const [project, session] = await Promise.all([
      ctx.project.getCurrent(),
      ctx.session.getCurrent(),
    ]);

    if (!project) {
      return {
        type: "empty",
        title: "No project is open",
        description: "Open a project to view its health information.",
      };
    }

    return {
      type: "column",
      gap: "md",
      children: [
        { type: "text", value: project.name, tone: "accent", selectable: true },
        { type: "text", value: `Trusted: ${project.trusted ? "yes" : "no"}` },
        { type: "text", value: `Session: ${session?.title ?? "none"}`, tone: "muted" },
        {
          type: "button",
          label: "Refresh project health",
          command: "example.project-health.refresh",
        },
      ],
    };
  });
}
