// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntelligentUiScope, setIntelligentUiLocale } from './renderer.js';
import type { IntelligentUiHost, IntelligentUiScope } from './renderer.js';

const scopes: IntelligentUiScope[] = [];
const tick = async (): Promise<void> => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

function mount(spec: unknown, host: IntelligentUiHost = {}): { root: HTMLElement; scope: IntelligentUiScope; ui: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'message-markdown';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-hermes-ui';
  code.textContent = typeof spec === 'string' ? spec : JSON.stringify(spec);
  pre.append(code);
  root.append(pre);
  document.body.append(root);
  const scope = createIntelligentUiScope();
  scopes.push(scope);
  scope.enhance(root, host);
  return { root, scope, ui: root.querySelector('.hui') as HTMLElement };
}
const body = (...nodes: unknown[]) => ({ title: 'T', body: nodes });
const noteOf = (element: Element | null): string => element?.querySelector('.hui-media__note')?.textContent ?? '';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setIntelligentUiLocale('en-US');
});

describe('images and media sources', () => {
  it('shows an image from the blob URL the host resolved for its file name', async () => {
    const resolveFile = vi.fn().mockResolvedValue('blob:img-1');
    const { ui } = mount(body({ type: 'image', file: 'out/a.png', alt: 'A chart', caption: 'Figure 1' }), { resolveFile });
    await tick();
    expect(resolveFile).toHaveBeenCalledWith('out/a.png');
    const image = ui.querySelector('figure.hui-image img')!;
    expect(image.getAttribute('src')).toBe('blob:img-1');
    expect(image.getAttribute('alt')).toBe('A chart');
    expect(ui.querySelector('figcaption')?.textContent).toBe('Figure 1');
    expect(ui.querySelector('.hui-media--waiting, .hui-media--missing, .hui-media--remote')).toBeNull();
  });

  it('waits for a file that is not there yet and shows it when it arrives', async () => {
    vi.useFakeTimers();
    const resolveFile = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('blob:later');
    const { ui } = mount(body({ type: 'image', file: 'later.png' }), { resolveFile });
    await vi.advanceTimersByTimeAsync(0);
    const figure = ui.querySelector('figure.hui-image')!;
    expect(figure.classList.contains('hui-media--waiting')).toBe(true);
    expect(noteOf(figure)).toBe('Waiting for the file: later.png');
    expect(figure.querySelector('img')!.hasAttribute('src')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolveFile).toHaveBeenCalledTimes(2);
    expect(figure.classList.contains('hui-media--waiting')).toBe(false);
    expect(figure.querySelector('img')!.getAttribute('src')).toBe('blob:later');
  });

  it('gives up after the last look and says the file is missing', async () => {
    vi.useFakeTimers();
    const resolveFile = vi.fn().mockResolvedValue(null);
    const { ui } = mount(body({ type: 'audio', file: 'never.wav' }), { resolveFile });
    await vi.advanceTimersByTimeAsync(10 * 1000 + 60 * 3000 + 1000);
    const figure = ui.querySelector('figure.hui-player')!;
    expect(figure.classList.contains('hui-media--missing')).toBe(true);
    expect(noteOf(figure)).toBe('File not found: never.wav');
    const calls = resolveFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolveFile).toHaveBeenCalledTimes(calls);
  });

  it('stops asking at once when the host refuses the name, and without a host file source', async () => {
    const { ui } = mount(body({ type: 'image', file: '../secret.png' }), { resolveFile: vi.fn().mockRejectedValue(new Error('INVALID_ARGUMENT')) });
    await tick();
    expect(ui.querySelector('figure')!.classList.contains('hui-media--missing')).toBe(true);
    expect(noteOf(ui.querySelector('figure'))).toBe('File not found: ../secret.png');
    document.body.replaceChildren();
    const bare = mount(body({ type: 'video', file: 'a.mp4' }));
    await tick();
    expect(noteOf(bare.ui.querySelector('figure'))).toBe('Files are not available here: a.mp4');
  });

  it('never puts an address that is not a host blob URL on a media element', async () => {
    const { ui } = mount(body({ type: 'image', file: 'a.png' }), { resolveFile: vi.fn().mockResolvedValue('https://evil.example/a.png') });
    await tick();
    expect(ui.querySelector('img')!.hasAttribute('src')).toBe(false);
  });

  it('shows a remote address as a note with Copy link, and Open link only when the host opens links', async () => {
    const copy = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const { ui } = mount(body({ type: 'image', src: 'https://example.com/pic.png', alt: 'Pic' }), { copy, notify });
    const figure = ui.querySelector('figure')!;
    expect(figure.classList.contains('hui-media--remote')).toBe(true);
    expect(figure.querySelector('img')!.hasAttribute('src')).toBe(false);
    expect(noteOf(figure)).toContain('Not shown in this app: Pic');
    const actions = [...figure.querySelectorAll<HTMLButtonElement>('.hui-media__action')];
    expect(actions.map(item => item.textContent)).toEqual(['Copy link']);
    actions[0]!.click();
    await tick();
    expect(copy).toHaveBeenCalledWith('https://example.com/pic.png');
    expect(notify).toHaveBeenCalledWith('Link copied');
    const openLink = vi.fn().mockResolvedValue(true);
    document.body.replaceChildren();
    const withOpen = mount(body({ type: 'video', src: 'https://www.youtube.com/watch?v=abc123' }), { copy, openLink });
    const labels = [...withOpen.ui.querySelectorAll('.hui-media__action')].map(item => item.textContent);
    expect(labels).toEqual(['Open link', 'Copy link']);
    (withOpen.ui.querySelector('.hui-media__action') as HTMLButtonElement).click();
    await tick();
    expect(openLink).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc123');
    expect(withOpen.ui.querySelector('iframe')).toBeNull();
  });

  it('does not offer an address that is not https', () => {
    const { ui } = mount(body({ type: 'image', src: '/media/a.png' }));
    expect(noteOf(ui.querySelector('figure'))).toContain('Not shown in this app: /media/a.png');
    expect(ui.querySelectorAll('.hui-media__action')).toHaveLength(0);
  });

  it('waits for a media node to close while the answer streams, then draws it', async () => {
    const resolveFile = vi.fn().mockResolvedValue('blob:a');
    const { ui } = mount('{"title":"T","body":[{"type":"image","file":"a.png"},{"type":"image","file":"=item.ti', { resolveFile });
    await tick();
    expect(ui.querySelectorAll('figure.hui-image')).toHaveLength(1);
    expect(resolveFile).toHaveBeenCalledTimes(1);
    expect(resolveFile).toHaveBeenCalledWith('a.png');
  });

  it('lays out a gallery from file names, objects and remote addresses', async () => {
    const resolveFile = vi.fn().mockResolvedValue('blob:g');
    const { ui } = mount(body({ type: 'gallery', columns: 3, items: ['a.png', { file: 'b.png', alt: 'B' }, 'https://example.com/c.png', 7] }), { resolveFile });
    await tick();
    const gallery = ui.querySelector<HTMLElement>('.hui-gallery')!;
    expect(gallery.style.getPropertyValue('--hui-gallery-columns')).toBe('3');
    expect(gallery.querySelectorAll('figure.hui-image')).toHaveLength(3);
    expect(resolveFile.mock.calls.map(call => call[0])).toEqual(['a.png', 'b.png']);
    expect(gallery.querySelectorAll('.hui-media--remote')).toHaveLength(1);
  });
});

describe('players', () => {
  it('builds a video with controls, writes its time to the state and jumps to a marker', async () => {
    const { ui } = mount({ title: 'T', state: { t: 0 }, body: [
      { type: 'video', file: 'a.mp4', id: 'v1', bind: 't', markers: [{ time: 65, label: 'Intro' }, { time: -1 }] },
      { type: 'text', text: 'at {{t}}' },
    ] }, { resolveFile: vi.fn().mockResolvedValue('blob:v') });
    await tick();
    const video = ui.querySelector('video.hui-player__media') as HTMLVideoElement;
    expect(video.controls).toBe(true);
    expect(video.getAttribute('src')).toBe('blob:v');
    const markers = ui.querySelectorAll<HTMLButtonElement>('.hui-player__marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.textContent).toBe('1:05Intro');
    markers[0]!.click();
    expect(video.currentTime).toBe(65);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    video.currentTime = 7.5;
    video.dispatchEvent(new Event('seeked'));
    await tick();
    expect(ui.querySelector('.hui-text')!.textContent).toBe('at 7.5');
  });

  it('builds an audio player and controls a player from buttons by id', () => {
    const { ui } = mount(body(
      { type: 'audio', file: 'a.wav', id: 'a1', title: 'Take 1' },
      { type: 'button', label: 'Jump', action: { type: 'seek', target: 'a1', time: 12, play: true } },
      { type: 'button', label: 'Stop', action: { type: 'pause' } },
      { type: 'button', label: 'Go', action: { type: 'play', target: 'a1' } },
    ), { resolveFile: vi.fn().mockResolvedValue('blob:a') });
    const audio = ui.querySelector('audio.hui-player__media') as HTMLAudioElement;
    expect(ui.querySelector('.hui-player__title')!.textContent).toBe('Take 1');
    const [jump, stop, go] = [...ui.querySelectorAll<HTMLButtonElement>('.hui-button')];
    jump!.click();
    expect(audio.currentTime).toBe(12);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    stop!.click();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    go!.click();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('plays a playlist item after item, following the index in the state', async () => {
    const resolveFile = vi.fn(async (name: string) => `blob:${name}`);
    const { ui } = mount({ title: 'T', state: { clips: [{ id: 'a', file: 'a.mp4' }, { id: 'b', file: 'b.mp4', start: 2, end: 4 }], at: 0 }, body: [
      { type: 'video', playlist: '=clips', playlistKey: 'id', currentIndexBind: 'at' },
      { type: 'text', text: 'item {{at}}' },
    ] }, { resolveFile });
    await tick();
    const video = ui.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('blob:a.mp4');
    video.dispatchEvent(new Event('ended'));
    await tick();
    expect(ui.querySelector('.hui-text')!.textContent).toBe('item 1');
    expect(video.getAttribute('src')).toBe('blob:b.mp4');
    expect(resolveFile).toHaveBeenCalledWith('b.mp4');
  });
});

describe('stage, selection and regions', () => {
  it('lays captions over an image and draws a fixed region at its fractions', async () => {
    const { ui } = mount(body({ type: 'image', file: 'a.png', overlay: [
      { type: 'region', x: 0.25, y: 0.5, w: 0.5, h: 0.2, children: [{ type: 'text', text: 'Caption' }] },
    ] }), { resolveFile: vi.fn().mockResolvedValue('blob:i') });
    await tick();
    const region = ui.querySelector<HTMLElement>('.hui-stage__layer .hui-region')!;
    expect(parseFloat(region.style.left)).toBeCloseTo(25, 5);
    expect(parseFloat(region.style.top)).toBeCloseTo(50, 5);
    expect(parseFloat(region.style.width)).toBeCloseTo(50, 5);
    expect(region.querySelector('.hui-region__content')!.textContent).toBe('Caption');
    expect(region.hasAttribute('tabindex')).toBe(false);
    expect(ui.querySelector('.hui-stage > img')).not.toBeNull();
  });

  it('draws a crop frame that the keyboard moves and resizes, writing fractions to the state', async () => {
    const { ui } = mount({ title: 'T', state: {}, body: [
      { type: 'image', file: 'a.png', selection: { bind: 'crop', label: 'Crop' } },
      { type: 'text', text: '{{crop.x}}|{{crop.w}}' },
    ] }, { resolveFile: vi.fn().mockResolvedValue('blob:i') });
    await tick();
    const frame = ui.querySelector<HTMLElement>('.hui-region--mask')!;
    expect(frame.getAttribute('aria-label')).toBe('Crop: arrow keys move, Shift and arrow keys resize');
    expect(frame.tabIndex).toBe(0);
    expect(frame.querySelectorAll('.hui-region__handle')).toHaveLength(4);
    expect(parseFloat(frame.style.left)).toBeCloseTo(10, 5);
    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await tick();
    expect(parseFloat(frame.style.left)).toBeCloseTo(11, 5);
    expect(ui.querySelector('.hui-text')!.textContent).toBe('0.11|0.8');
    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    await tick();
    expect(parseFloat(frame.style.width)).toBeCloseTo(81, 5);
  });

  it('names a draggable region by its label and gives it handles only when it can be resized', () => {
    const { ui } = mount(body(
      { type: 'video', file: 'a.mp4', overlay: [{ type: 'region', bind: 'box', label: 'Logo' }] },
    ), { resolveFile: vi.fn().mockResolvedValue('blob:v') });
    const region = ui.querySelector<HTMLElement>('.hui-region')!;
    expect(region.getAttribute('aria-label')).toBe('Logo: arrow keys move');
    expect(region.querySelectorAll('.hui-region__handle')).toHaveLength(0);
  });
});

describe('range with a player', () => {
  it('shows the playback position, previews the frame of a handle and seeks on a click of the scale', async () => {
    const { ui } = mount({ title: 'T', state: { s: 2, e: 8 }, body: [
      { type: 'video', file: 'a.mp4', id: 'v1' },
      { type: 'range', bindStart: 's', bindEnd: 'e', min: 0, max: 10, label: 'Segment', player: 'v1' },
    ] }, { resolveFile: vi.fn().mockResolvedValue('blob:v') });
    await tick();
    const video = ui.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'readyState', { value: 1 });
    const playhead = ui.querySelector<HTMLElement>('.hui-range__playhead')!;
    video.currentTime = 5;
    video.dispatchEvent(new Event('timeupdate'));
    expect(playhead.hidden).toBe(false);
    expect(parseFloat(playhead.style.left)).toBeCloseTo(50, 5);
    const low = ui.querySelector('.hui-range__input--start') as HTMLInputElement;
    low.value = '3';
    low.dispatchEvent(new Event('input'));
    expect(video.currentTime).toBe(3);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    const track = ui.querySelector<HTMLElement>('.hui-range__track')!;
    track.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, right: 200, bottom: 4, height: 4, x: 0, y: 0, toJSON: () => ({}) });
    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
    expect(video.currentTime).toBe(5);
  });

  it('keeps the playhead hidden without a player', () => {
    const { ui } = mount({ title: 'T', state: { s: 2, e: 8 }, body: [{ type: 'range', bindStart: 's', bindEnd: 'e', min: 0, max: 10 }] });
    expect(ui.querySelector<HTMLElement>('.hui-range__playhead')!.hidden).toBe(true);
  });
});

describe('links', () => {
  it('turns an https link in text into a button that opens through the host, and leaves other schemes as text', async () => {
    const openLink = vi.fn().mockResolvedValue(true);
    const { ui } = mount(body({ type: 'text', text: 'See [docs](https://example.com/x) or [bad](javascript:alert(1)) or [plain](http://example.com)' }), { openLink });
    const links = ui.querySelectorAll<HTMLButtonElement>('button.hui-link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('role')).toBe('link');
    expect(links[0]!.title).toBe('https://example.com/x');
    expect(ui.querySelector('.hui-text')!.textContent).toContain('bad');
    links[0]!.click();
    await tick();
    expect(openLink).toHaveBeenCalledWith('https://example.com/x');
  });

  it('copies the address and says so when the host cannot open links, and reports a failed open', async () => {
    const copy = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const { ui } = mount(body({ type: 'link', text: 'Docs', href: 'https://example.com/docs' }), { copy, notify });
    (ui.querySelector('button.hui-link') as HTMLButtonElement).click();
    await tick();
    expect(copy).toHaveBeenCalledWith('https://example.com/docs');
    expect(notify).toHaveBeenLastCalledWith('Link copied');
    document.body.replaceChildren();
    const refused = vi.fn().mockResolvedValue(false);
    const failing = mount(body({ type: 'link', text: 'Docs', href: 'https://example.com/docs' }), { openLink: refused, notify });
    (failing.ui.querySelector('button.hui-link') as HTMLButtonElement).click();
    await tick();
    expect(notify).toHaveBeenLastCalledWith('Could not open the link.');
  });

  it('disables a link node whose address is not https', () => {
    const { ui } = mount(body({ type: 'link', text: 'Mail', href: 'mailto:a@example.com' }, { type: 'link', text: 'Rel', href: '/a' }));
    const links = ui.querySelectorAll<HTMLButtonElement>('button.hui-link');
    expect([...links].every(link => link.disabled)).toBe(true);
  });
});

describe('formulas and custom HTML', () => {
  it('hands TeX to the host typesetter, literally unless it starts with =', () => {
    const renderFormula = vi.fn();
    const { ui } = mount({ title: 'T', state: { f: 'x^{{2}}' }, body: [
      { type: 'formula', tex: 'E = mc^{{2}}' },
      { type: 'formula', tex: '=f', inline: true },
    ] }, { renderFormula });
    const [first, second] = ui.querySelectorAll('.hui-formula');
    expect(first!.textContent).toBe('E = mc^{{2}}');
    expect(renderFormula).toHaveBeenNthCalledWith(1, first, 'E = mc^{{2}}', true);
    expect(renderFormula).toHaveBeenNthCalledWith(2, second, 'x^{{2}}', false);
  });

  it('shows the TeX text when the host has no typesetter', () => {
    const { ui } = mount(body({ type: 'formula', tex: 'a+b' }));
    expect(ui.querySelector('.hui-formula')!.textContent).toBe('a+b');
  });

  it.each(['html', 'canvas'])('shows a note and nothing executable for a %s node', type => {
    const { ui } = mount(body({ type, html: '<b onclick="x()">hi</b><script>alert(1)</script>', title: 'Simulation' }, { type, html: '<i>x</i>' }));
    const notes = [...ui.querySelectorAll('.hui__note')].map(note => note.textContent);
    expect(notes).toEqual(['Not shown in this app: Simulation', 'Custom HTML is not shown in this app.']);
    expect(ui.querySelector('script, iframe, b, i')).toBeNull();
  });
});

describe('buttons that cannot act', () => {
  const send = { type: 'button', label: 'Go', action: { type: 'send', text: 'hi' } };

  it('disables a send button with the host reason, read live, and enables it after a refresh', async () => {
    let reason: string | null = 'The agent is still answering.';
    const post = vi.fn().mockResolvedValue(true);
    const { ui, scope } = mount(body(send), { send: post, sendBlock: () => reason });
    const button = ui.querySelector('button.hui-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('The agent is still answering.');
    reason = null;
    scope.refresh();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    button.click();
    await tick();
    expect(post).toHaveBeenCalledWith('hi', null);
  });

  it('says there is no sending when the host cannot send, and shows the real reason after a refused send', async () => {
    const bare = mount(body(send));
    const off = bare.ui.querySelector('button.hui-button') as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.title).toBe('Sending is not available here');
    document.body.replaceChildren();
    let reason: string | null = null;
    const { ui } = mount(body(send), { send: vi.fn(async () => { reason = 'This chat is closed.'; return false; }), sendBlock: () => reason });
    const button = ui.querySelector('button.hui-button') as HTMLButtonElement;
    button.click();
    await tick();
    expect(button.querySelector('span')!.textContent).toBe('This chat is closed.');
    expect(button.disabled).toBe(true);
  });

  it('runs only the closed list of application actions the host provides', async () => {
    const app = vi.fn().mockResolvedValue(true);
    const { ui } = mount(body(
      { type: 'button', label: 'Settings', action: { type: 'app', target: 'open_settings' } },
      { type: 'button', label: 'Telegram', action: { type: 'app', target: 'connect_telegram' } },
    ), { app });
    const [settings, telegram] = [...ui.querySelectorAll<HTMLButtonElement>('button.hui-button')];
    expect(telegram!.disabled).toBe(true);
    expect(telegram!.title).toBe('Not available in this app');
    expect(settings!.disabled).toBe(false);
    settings!.click();
    await tick();
    expect(app).toHaveBeenCalledOnce();
    expect(app).toHaveBeenCalledWith('open_settings');
    document.body.replaceChildren();
    const none = mount(body({ type: 'button', label: 'S', action: { type: 'app', target: 'open_settings' } }));
    expect((none.ui.querySelector('button.hui-button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('rebuilding mounted answers', () => {
  it('redraws the interface in the new language and keeps the state the person set', async () => {
    let prefix = '';
    const host: IntelligentUiHost = { label: key => `${prefix}${key}` };
    const spec = { title: 'T', state: { n: 1 }, body: [
      { type: 'button', label: 'Set', action: { type: 'set', values: { n: 5 } } },
      { type: 'text', text: 'n={{n}}' },
    ] };
    const { root, scope, ui } = mount(spec, host);
    (ui.querySelector('button.hui-button') as HTMLButtonElement).click();
    await tick();
    expect(root.querySelector('.hui-text')!.textContent).toBe('n=5');
    expect(root.querySelector('.hui__reset')!.textContent).toBe('Reset');
    prefix = 'ru:';
    scope.rebuild();
    scope.enhance(root, host);
    expect(root.querySelector('.hui__reset')!.textContent).toBe('ru:Reset');
    expect(root.querySelector('.hui-text')!.textContent).toBe('n=5');
    expect(root.querySelectorAll('.hui')).toHaveLength(1);
  });

  it('does not rebuild an unchanged interface without being asked', () => {
    const { root, scope, ui } = mount(body({ type: 'text', text: 'x' }));
    scope.enhance(root, {});
    expect(root.querySelector('.hui')).toBe(ui);
    expect(ui.querySelector('.hui__body')).not.toBeNull();
  });
});
