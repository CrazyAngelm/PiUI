/**
 * Deterministic randomness for seeded content. Nothing in the lab calls
 * Math.random: every generated value derives from a string seed.
 */
export interface LabRandom {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

/** cyrb128: a small, well-distributed 128-bit string hash. */
function cyrb128(value: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function hashString(value: string): number {
  return cyrb128(value)[0];
}

/** mulberry32 seeded from a string. */
export function createRandom(seed: string): LabRandom {
  let state = hashString(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(values: readonly T[]): T => {
      const value = values[Math.floor(next() * values.length)];
      if (value === undefined) throw new Error('Cannot pick from an empty list.');
      return value;
    },
    chance: (probability) => next() < probability,
  };
}

/** A stable RFC 4122 v4-shaped UUID derived from a seed string. */
export function labUuid(seed: string): string {
  const hex = cyrb128(seed).map((word) => word.toString(16).padStart(8, '0')).join('');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Sequential deterministic identifiers for entities created during a lab session. */
export class LabIdSource {
  private readonly counters = new Map<string, number>();

  constructor(private readonly namespace: string) {}

  next(kind: string): string {
    const count = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, count);
    return labUuid(`${this.namespace}:${kind}:${count}`);
  }
}

const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** Mirrors `Uuid::parse_str` for the hyphenated and simple forms the UI can send. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
