import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { setLanguage } from '../../features/locale/language';
import { AttentionStore } from '../attention/attention.svelte';
import AttentionSettings from './AttentionSettings.svelte';

const store = (stored?: object): AttentionStore =>
  new AttentionStore({ getItem: () => (stored === undefined ? null : JSON.stringify(stored)), setItem: () => undefined });

const html = (attention: AttentionStore): string =>
  render(AttentionSettings, { props: { store: attention, play: async () => true } }).body;

/** The opening tag of the first element that carries `marker`. */
function tagWith(body: string, marker: string): string {
  const at = body.indexOf(marker);
  const open = body.lastIndexOf('<', at);
  return open === -1 || at === -1 ? '' : body.slice(open, body.indexOf('>', at) + 1);
}

afterEach(() => setLanguage('en'));

describe('Settings -> Notifications', () => {
  it('names every control and has no hint paragraphs', () => {
    const body = html(store());
    expect(body).toContain('Notifications');
    for (const label of [
      'Play a sound',
      'Show a number on the taskbar button',
      'Flash the taskbar button',
      'A chat finishes its turn',
      'A chat needs an approval or an answer',
      'A chat fails',
    ]) {
      expect(tagWith(body, `aria-label="${label}"`), label).toContain('role="switch"');
    }
    expect(body).toContain('Notify me when');
    expect(body).toContain('role="group"');
    expect(body).not.toMatch(/<p[\s>]/);
    expect(body).toMatch(/<label[^>]*for="[^"]*-sound"/);
    expect(body).toMatch(/<label[^>]*for="[^"]*-volume"/);
  });

  it('shows the defaults: everything on, the chime, 60%', () => {
    const body = html(store());
    expect(body.match(/aria-checked="true"/g)).toHaveLength(6);
    expect(body).toMatch(/<option value="chime"[^>]*selected/);
    expect(tagWith(body, 'type="range"')).toContain('value="60"');
    for (const name of ['Chime', 'Bell', 'Pop', 'Marimba']) expect(body).toContain(`>${name}</option>`);
    expect(body).toContain('Play');
  });

  it('shows the saved settings', () => {
    const body = html(store({ sound: false, soundId: 'marimba', volume: 0.35, badge: false, onFailed: false }));
    expect(body.match(/aria-checked="false"/g)).toHaveLength(3);
    expect(body).toMatch(/<option value="marimba"[^>]*selected/);
    expect(tagWith(body, 'type="range"')).toContain('value="35"');
  });

  it('disables the sound choice, the volume and the preview while the sound is off', () => {
    const off = html(store({ sound: false }));
    expect(tagWith(off, 'class="select')).toContain('disabled');
    expect(tagWith(off, 'type="range"')).toContain('disabled');
    expect(off).toMatch(/<button[^>]*btn--secondary[^>]*disabled/);
    const on = html(store());
    expect(on).not.toMatch(/<button[^>]*btn--secondary[^>]*disabled/);
    expect(tagWith(on, 'class="select')).not.toContain('disabled');
    expect(tagWith(on, 'type="range"')).not.toContain('disabled');
  });

  it('speaks Russian', () => {
    setLanguage('ru');
    const body = html(store());
    expect(body).toContain('Уведомления');
    expect(body).toContain('Воспроизводить звук');
    expect(body).toContain('Громкость');
    expect(body).toContain('Маримба');
  });
});
