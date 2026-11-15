import { afterEach, describe, expect, it, vi } from 'vitest';
import { playSound, resetSounds, SOUND_IDS, soundLength, type SoundId } from './sounds';

interface Param {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
}

const param = (): Param => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 1;
  destination = { kind: 'destination' };
  oscillators: { type: string; frequency: Param; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  gains: { gain: Param }[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = { gain: param(), connect: vi.fn() };
    this.gains.push(node);
    return node;
  }

  createOscillator() {
    const node = { type: 'sine', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    this.oscillators.push(node);
    return node;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSounds();
  FakeAudioContext.instances = [];
});

describe('attention sounds', () => {
  it('offers the four presets', () => {
    expect(SOUND_IDS).toEqual(['chime', 'bell', 'pop', 'marimba']);
  });

  it.each(SOUND_IDS)('%s is shorter than a second and schedules oscillators that start and stop', async (id: SoundId) => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    expect(soundLength(id)).toBeLessThan(1);
    expect(await playSound(id, 0.6)).toBe(true);
    const [audio] = FakeAudioContext.instances;
    expect(audio?.oscillators.length).toBeGreaterThan(0);
    for (const oscillator of audio?.oscillators ?? []) {
      expect(oscillator.start).toHaveBeenCalledOnce();
      expect(oscillator.stop).toHaveBeenCalledOnce();
      const stopAt = oscillator.stop.mock.calls[0]?.[0] as number;
      expect(stopAt).toBeGreaterThan(1);
      expect(stopAt - (audio?.currentTime ?? 0)).toBeLessThan(1.1);
    }
    // Every note fades out to near silence.
    const faded = (audio?.gains ?? []).flatMap((node) => node.gain.exponentialRampToValueAtTime.mock.calls.map((call) => call[0] as number));
    expect(faded.some((level) => level < 0.001)).toBe(true);
  });

  it('chime is a rising two-note interval', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await playSound('chime', 1);
    const starts = FakeAudioContext.instances[0]?.oscillators
      .filter((oscillator) => oscillator.type === 'sine')
      .map((oscillator) => oscillator.frequency.setValueAtTime.mock.calls[0]?.[0] as number);
    expect(starts?.[0]).toBeLessThan(starts?.[2] ?? 0);
  });

  it('scales the level with the volume and plays nothing at 0', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await playSound('pop', 1);
    const loud = FakeAudioContext.instances[0]?.gains[0]?.gain.value ?? 0;
    resetSounds();
    await playSound('pop', 0.5);
    const quiet = FakeAudioContext.instances[1]?.gains[0]?.gain.value ?? 0;
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(loud);
    const before = FakeAudioContext.instances[1]?.oscillators.length ?? 0;
    expect(await playSound('pop', 0)).toBe(false);
    expect(FakeAudioContext.instances[1]?.oscillators.length).toBe(before);
  });

  it('shares one context and resumes it when it is suspended', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await playSound('bell', 0.5);
    const [audio] = FakeAudioContext.instances;
    if (audio) audio.state = 'suspended';
    await playSound('bell', 0.5);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(audio?.resume).toHaveBeenCalledOnce();
  });

  it('does not play late when the browser keeps the context suspended', async () => {
    class Stuck extends FakeAudioContext {
      constructor() {
        super();
        this.state = 'suspended';
        this.resume = vi.fn(() => new Promise<void>(() => undefined));
      }
    }
    vi.stubGlobal('AudioContext', Stuck);
    expect(await playSound('marimba', 0.5)).toBe(false);
    expect(FakeAudioContext.instances[0]?.oscillators).toHaveLength(0);
  });

  it('fails silently without an AudioContext and when audio throws', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    for (const id of SOUND_IDS) expect(await playSound(id, 0.6)).toBe(false);
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no audio device');
        }
      },
    );
    for (const id of SOUND_IDS) expect(await playSound(id, 0.6)).toBe(false);
  });

  it('ignores an unknown preset and a volume that is not a number', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    expect(await playSound('airhorn' as SoundId, 0.5)).toBe(false);
    expect(await playSound('chime', Number.NaN)).toBe(false);
  });
});
