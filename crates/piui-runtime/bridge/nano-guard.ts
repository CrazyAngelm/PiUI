/**
 * Nano approval guard: a Pi extension that asks before the agent runs a shell
 * command or changes a file.
 *
 * This is an approval prompt, NOT a sandbox. Pi and everything it starts run
 * with the user's own operating-system permissions. The guard only gives the
 * person a chance to say no before a call runs; it cannot see what an allowed
 * command does afterwards, and it cannot stop another process.
 *
 * The host (PiUI / Nano Desktop) embeds this file, writes it next to the Nano
 * agent directory and passes it to Pi with `-e <path>` in the `native`
 * permission mode. `read-only` never reaches it (the host removes the tools)
 * and `full-access` does not load it.
 *
 * Behaviour:
 * - `read`, `grep`, `find` and `ls` pass without a question.
 * - Shell commands, `write`, `edit`, and other tools ask
 *   through `ctx.ui.select` with the options "Allow once" and "Deny". In Pi RPC
 *   mode that dialog becomes an `extension_ui_request`, which the bridge shows
 *   as an approval card.
 * - Deny, a cancelled or timed-out dialog, an interrupted turn, a failure to
 *   ask, or a session without a UI all block the call (fail closed).
 * - Nothing is remembered: every call asks again.
 * - The question shows the whole command or path unchanged (line breaks kept,
 *   invisible and bidi characters escaped); a call too long to show is blocked.
 *
 * The file is self-contained on purpose: no imports, so it loads from any
 * directory without module resolution.
 */

type ToolCallEvent = { toolName: string; input?: Record<string, unknown> };
type ToolCallResult = { block: true; reason: string } | undefined;
type GuardContext = {
	hasUI?: boolean;
	signal?: AbortSignal;
	ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
};
type GuardApi = {
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: GuardContext) => Promise<ToolCallResult> | ToolCallResult): void;
};

const ALLOW = "Allow once";
const DENY = "Deny";
// Tools that only read the workspace. Everything else asks.
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
// The person approves exactly what runs: the text is shown whole, never
// shortened or re-spaced. Anything longer is refused instead of asked about.
const MAX_SHOWN = 4000;
// Characters that would hide or reorder what is shown: control characters
// (line breaks and tabs stay as they are), line/paragraph separators, bidi
// controls and zero-width characters. They are shown as \u{...} escapes.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

function shown(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
	if (text.trim() === "") return "(empty)";
	const visible = text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`);
	return visible.length <= MAX_SHOWN ? visible : undefined;
}

function question(event: ToolCallEvent): string | undefined {
	const input = event.input ?? {};
	const shell = ["bash", "powershell", "nano_powershell"].includes(event.toolName);
	const label =
		shell ? "Run command" : event.toolName === "write" ? "Write file" : event.toolName === "edit" ? "Edit file" : undefined;
	if (label === undefined) {
		const name = shown(event.toolName);
		return name === undefined ? undefined : `Run tool: ${name}`;
	}
	const subject = shown(shell ? input.command : input.path);
	return subject === undefined ? undefined : `${label}: ${subject}`;
}

export default function nanoGuard(pi: GuardApi): void {
	pi.on("tool_call", async (event, ctx) => {
		if (READ_ONLY.has(event.toolName)) return undefined;
		if (!ctx.hasUI) return { block: true, reason: "Blocked: no way to ask for approval in this session." };
		const title = question(event);
		if (title === undefined) {
			return { block: true, reason: `Blocked: the call is too long to show for approval (over ${MAX_SHOWN} characters). Split it into smaller steps.` };
		}
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(title, [ALLOW, DENY], ctx.signal ? { signal: ctx.signal } : undefined);
		} catch {
			return { block: true, reason: "Blocked: the approval request failed." };
		}
		if (choice === ALLOW) return undefined;
		return { block: true, reason: choice === DENY ? "Denied by the user." : "Blocked: no approval was given." };
	});
}
