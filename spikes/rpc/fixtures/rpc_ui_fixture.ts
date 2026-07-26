import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic-only fixture for the documented RPC Extension UI protocol. */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTitle("PiUI RPC synthetic fixture");
    ctx.ui.setStatus("piui-spike", "ready");
    ctx.ui.setWidget("piui-spike", ["Synthetic fixture", "No user data"]);
  });

  pi.registerCommand("piui-rpc-ui-fixture", {
    description: "Exercise documented RPC UI methods with synthetic values.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Synthetic fixture started", "info");
      ctx.ui.setStatus("piui-spike", "dialog sequence");
      ctx.ui.setWidget("piui-spike", ["Synthetic fixture", "dialog sequence"]);
      ctx.ui.setTitle("PiUI RPC synthetic fixture running");
      ctx.ui.setEditorText("synthetic editor text");
      await ctx.ui.select("Synthetic select", ["one", "two"]);
      await ctx.ui.confirm("Synthetic confirm", "No action is performed.");
      await ctx.ui.input("Synthetic input", "synthetic value");
      await ctx.ui.editor("Synthetic editor", "synthetic\ntext");
      ctx.ui.notify("Synthetic fixture completed", "info");
      ctx.ui.setStatus("piui-spike", undefined);
      ctx.ui.setWidget("piui-spike", undefined);
    },
  });
}
