import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";

type Command = { name: string; source: string; sourceInfo?: { path?: string } };
type CommandContext = { ui: { notify(message: string, level: "info"): void } };
type SkillPathsApi = {
	getCommands(): Command[];
	registerProvider(name: string, config: { apiKey: string }): void;
	registerCommand(name: string, command: {
		description: string;
		handler(args: string, ctx: CommandContext): Promise<void>;
	}): void;
};

export default function nanoSkillPaths(pi: SkillPathsApi): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("The Nano agent directory is missing.");
	// Use Node's cache, not Pi's extension loader, to reuse the preloaded key.
	const require = createRequire(join(agentDir, "models.json"));
	const bindRelayAuth = require("./bundled/relay-auth.cjs");
	bindRelayAuth(pi);
	const skillPath = join(agentDir, "bundled", "bes-deep-mode", "SKILL.md");
	pi.registerCommand("skill-paths", {
		description: "Show the paths of loaded Nano skills",
		async handler(_args, ctx) {
			const loaded = pi.getCommands().some((command) => {
				const path = command.sourceInfo?.path;
				return command.source === "skill" && command.name === "skill:bes-deep-mode" &&
					path && isAbsolute(path) && relative(skillPath, path) === "";
			});
			ctx.ui.notify(loaded ? `bes-deep-mode: ${skillPath}` : "No bundled Nano skills are loaded.", "info");
		},
	});
}
