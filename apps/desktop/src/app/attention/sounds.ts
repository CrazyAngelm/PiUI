/**
 * The attention sounds, synthesized with the Web Audio API: soft sine and
 * triangle partials with a quick attack and an exponential decay. There are no
 * audio assets, so the CSP needs no `media-src`. Each preset is under a second.
 */
export type SoundId = 'chime' | 'bell' | 'pop' | 'marimba';

export const SOUND_IDS: readonly SoundId[] = ['chime', 'bell', 'pop', 'marimba'];

interface Overtone {
  /** Multiple of the note's frequency. */
  readonly ratio: number;
  readonly gain: number;
  readonly type: 'sine' | 'triangle';
}

interface Note {
  /** Seconds after the start. */
  readonly at: number;
  readonly frequency: number;
  /** The pitch slides to this frequency over the first part of the note. */
  readonly glideTo?: number;
  /** Seconds from the start of the note until it is silent. */
  readonly length: number;
  readonly peak: number;
  readonly partials: readonly Overtone[];
}

const SOFT: readonly Overtone[] = [
  { ratio: 1, gain: 1, type: 'sine' },
  { ratio: 2, gain: 0.22, type: 'sine' },
];

const PRESETS: Readonly<Record<SoundId, readonly Note[]>> = {
  // A gentle rising fourth: G5, then C6.
  chime: [
    { at: 0, frequency: 783.99, length: 0.42, peak: 0.5, partials: SOFT },
    { at: 0.15, frequency: 1046.5, length: 0.5, peak: 0.5, partials: SOFT },
  ],
  // One struck bell: inharmonic partials ring down together.
  bell: [
    {
      at: 0,
      frequency: 880,
      length: 0.9,
      peak: 0.5,
      partials: [
        { ratio: 1, gain: 1, type: 'sine' },
        { ratio: 2.756, gain: 0.32, type: 'sine' },
        { ratio: 5.404, gain: 0.12, type: 'sine' },
      ],
    },
  ],
  // A soft bubble: a short upward slide.
  pop: [{ at: 0, frequency: 320, glideTo: 760, length: 0.18, peak: 0.6, partials: [{ ratio: 1, gain: 1, type: 'sine' }] }],
  // Three wooden notes of a major triad.
  marimba: [523.25, 659.25, 783.99].map((frequency, index) => ({
    at: index * 0.09,
    frequency,
    length: 0.3,
    peak: 0.5,
    partials: [
      { ratio: 1, gain: 1, type: 'triangle' as const },
      { ratio: 4, gain: 0.18, type: 'sine' as const },
    ],
  })),
};

/** The longest preset, in seconds; the tests hold every preset to under a second. */
export function soundLength(id: SoundId): number {
  return Math.max(...PRESETS[id].map((note) => note.at + note.length));
}

/** The whole mix is kept low: the notes above are peaks before this master level. */
const MASTER = 0.4;
const ATTACK = 0.012;
const FLOOR = 0.0001;
const RESUME_WAIT_MS = 300;

let context: AudioContext | undefined;

function audioContext(): AudioContext | undefined {
  if (context !== undefined && context.state !== 'closed') return context;
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (Constructor === undefined) return undefined;
  context = new Constructor();
  return context;
}

/** Forgets the shared context (tests). */
export function resetSounds(): void {
  context = undefined;
}

function schedule(audio: AudioContext, id: SoundId, volume: number): void {
  const start = audio.currentTime + 0.02;
  const master = audio.createGain();
  master.gain.value = MASTER * volume;
  master.connect(audio.destination);
  for (const note of PRESETS[id]) {
    const begin = start + note.at;
    const end = begin + note.length;
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(FLOOR, begin);
    envelope.gain.exponentialRampToValueAtTime(note.peak, begin + ATTACK);
    envelope.gain.exponentialRampToValueAtTime(FLOOR, end);
    envelope.connect(master);
    for (const partial of note.partials) {
      const oscillator = audio.createOscillator();
      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(note.frequency * partial.ratio, begin);
      if (note.glideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(note.glideTo * partial.ratio, begin + note.length * 0.4);
      const level = audio.createGain();
      level.gain.value = partial.gain;
      oscillator.connect(level);
      level.connect(envelope);
      oscillator.start(begin);
      oscillator.stop(end + 0.02);
    }
  }
}

/**
 * Plays a preset at `volume` (0..1). One shared context is created on first use
 * and resumed when the browser suspended it. It fails silently: no audio
 * support, a suspended context before the first user gesture, or a volume of 0
 * is simply no sound. Resolves to whether a sound was scheduled.
 */
export async function playSound(id: SoundId, volume: number): Promise<boolean> {
  try {
    const level = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : 0;
    if (level === 0 || !(id in PRESETS)) return false;
    const audio = audioContext();
    if (audio === undefined) return false;
    if (audio.state === 'suspended') {
      // Before the first user gesture a browser keeps resume() pending; do not play late.
      await Promise.race([audio.resume(), new Promise<void>((done) => setTimeout(done, RESUME_WAIT_MS))]);
      if (audio.state === 'suspended') return false;
    }
    schedule(audio, id, level);
    return true;
  } catch {
    return false;
  }
}
