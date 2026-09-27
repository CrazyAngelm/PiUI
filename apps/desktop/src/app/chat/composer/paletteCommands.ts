import type { NativeCommand } from '../../../host-api/composerInputsClient';
import type { SessionStatus } from '../../../../../../contracts/workspace-v15';

/**
 * Names the composer runs as PiUI commands (`/compact`, `/stop`, `/run`):
 * a native command of the same name is hidden there, so the palette hides it
 * too. Inserting such a name would run the PiUI command on send.
 */
export const PIUI_COMPOSER_COMMANDS: readonly string[] = ['compact', 'stop', 'run'];

/** Sessions whose native command catalog can be read (a live runtime). */
export function catalogReadable(status: SessionStatus | undefined): boolean {
  return status === 'idle' || status === 'running';
}

/**
 * The native `/` commands the palette lists for the open chat: the same
 * catalog the composer's `/` menu shows, without the names PiUI runs itself
 * and without commands already listed in the palette (Pi extension commands
 * a `piui.manifest.json` declares), each name once.
 */
export function paletteNativeCommands(commands: readonly NativeCommand[], listedElsewhere: readonly string[]): NativeCommand[] {
  const hidden = new Set([...PIUI_COMPOSER_COMMANDS, ...listedElsewhere]);
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (hidden.has(command.name) || seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

/** What choosing a command puts in the message box, like the composer's `/` menu: the harness runs it on send. */
export function commandText(command: Pick<NativeCommand, 'name'>): string {
  return `/${command.name} `;
}

/** The kind of native command, as the composer's badge names it (locale keys); plain commands have none. */
export const COMMAND_SOURCE_LABELS: Readonly<Partial<Record<NativeCommand['source'], string>>> = {
  extension: 'extension',
  prompt: 'prompt',
  skill: 'skill',
};
