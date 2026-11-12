import { accessSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

type ShellOperations = { exec(command: string, cwd: string, options: unknown): Promise<unknown> };

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
// Match Pi's PowerShell 5.1 handling of redirected native stderr and exit status.
const WINDOWS_POWERSHELL_EXIT_SUFFIX = '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

export default async function nanoWindowsPowerShell(pi: { registerTool(tool: unknown): void }): Promise<void> {
	const systemRoot = process.env.SystemRoot;
	if (process.platform !== "win32" || !systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
		throw new Error("The Nano Windows PowerShell path is unavailable.");
	}
	const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	accessSync(shell, constants.F_OK);

	// The launcher has already resolved Pi to its absolute package entry.
	// Import tools only from that package, regardless of the project directory.
	const entry = process.argv[1];
	if (!entry || !isAbsolute(entry)) throw new Error("The Nano Pi package path is unavailable.");
	const entryDir = dirname(entry);
	const dist = basename(entryDir) === "bundle" ? dirname(entryDir) : entryDir;
	const { createPowerShellToolDefinition } = await import(pathToFileURL(join(dist, "core", "tools", "powershell.js")).href);
	const { createLocalShellOperations } = await import(pathToFileURL(join(dist, "core", "tools", "bash.js")).href);
	const { POWERSHELL_ARGS } = await import(pathToFileURL(join(dist, "utils", "shell.js")).href);
	const operations: ShellOperations = createLocalShellOperations("PowerShell", () => ({ shell, args: POWERSHELL_ARGS }));
	const trustedOperations: ShellOperations = {
		exec(command, cwd, options) {
			const suffix = command.endsWith("`") ? "" : WINDOWS_POWERSHELL_EXIT_SUFFIX;
			return operations.exec(`${UTF8_OUTPUT_PREFIX}${command}${suffix}`, cwd, options);
		},
	};
	const definition = createPowerShellToolDefinition(process.cwd(), { operations: trustedOperations });
	pi.registerTool({ ...definition, name: "nano_powershell" });
}
