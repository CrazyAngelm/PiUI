import { describe, expect, it } from 'vitest';
import type { NativeCommand } from '../../../host-api/composerInputsClient';
import { labComposerCatalog } from '../../../host-api/lab/composerInputsFake';
import { catalogReadable, COMMAND_SOURCE_LABELS, commandText, paletteNativeCommands } from './paletteCommands';

const command = (name: string, source: NativeCommand['source'] = 'extension'): NativeCommand => ({ name, source });

describe('palette native commands', () => {
  it('lists the Pi catalog the composer shows, as text to insert', () => {
    const pi = labComposerCatalog('pi').commands;
    const listed = paletteNativeCommands(pi, []);
    expect(listed.map((item) => item.name)).toEqual(['deploy-preview', 'fix-tests', 'skill:release-notes', 'skill:lab-changelog']);
    expect(commandText(listed[0] ?? command('x'))).toBe('/deploy-preview ');
    expect(COMMAND_SOURCE_LABELS.skill).toBe('skill');
    expect(COMMAND_SOURCE_LABELS.command).toBeUndefined();
  });

  it('hides names PiUI runs itself, commands listed elsewhere and duplicates', () => {
    const listed = paletteNativeCommands(
      [command('compact', 'command'), command('stop'), command('run'), command('deploy'), command('deploy', 'prompt'), command('review')],
      ['review'],
    );
    expect(listed).toEqual([command('deploy')]);
  });

  it('reads a catalog only from a live session', () => {
    expect(catalogReadable('idle')).toBe(true);
    expect(catalogReadable('running')).toBe(true);
    for (const status of ['starting', 'stopping', 'closed', 'failed', undefined] as const) expect(catalogReadable(status)).toBe(false);
  });
});
