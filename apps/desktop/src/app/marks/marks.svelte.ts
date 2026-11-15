/** Marks on chats and projects: local UI metadata per device, never sent to a harness or the host. */
export const MARKS_STORAGE_KEY = 'piui.marks.v1';

export const MARK_SHAPES = ['circle', 'square', 'diamond', 'triangle', 'star', 'hexagon'] as const;
export const MARK_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'] as const;
export type MarkShape = (typeof MARK_SHAPES)[number];
export type MarkColor = (typeof MARK_COLORS)[number];
export type Mark = { kind: 'emoji'; value: string } | { kind: 'shape'; shape: MarkShape; color: MarkColor };
export interface MarksMap {
  projects: Record<string, Mark>;
  sessions: Record<string, Mark>;
}

const MAX_KEY = 512;
const MAX_EMOJI_UNITS = 16;
const MAX_ENTRIES = 5000;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function oneGrapheme(value: string): boolean {
  if (value === '' || value.length > MAX_EMOJI_UNITS || value.trim() !== value) return false;
  if (!segmenter) return [...value].length <= 2;
  let count = 0;
  for (const _ of segmenter.segment(value)) if (++count > 1) return false;
  return count === 1;
}

/** Returns the mark when the value is a well-formed one, else undefined. */
export function validMark(value: unknown): Mark | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'emoji') return typeof entry.value === 'string' && oneGrapheme(entry.value) ? { kind: 'emoji', value: entry.value } : undefined;
  if (entry.kind === 'shape') {
    const { shape, color } = entry;
    if ((MARK_SHAPES as readonly unknown[]).includes(shape) && (MARK_COLORS as readonly unknown[]).includes(color)) {
      return { kind: 'shape', shape: shape as MarkShape, color: color as MarkColor };
    }
  }
  return undefined;
}

type RawGroup = Record<string, unknown>;
/** Entries this build does not understand (a newer build wrote them): never shown, written back untouched. */
interface RawMarks {
  projects: RawGroup;
  sessions: RawGroup;
}

function parseGroup(value: unknown): { known: Record<string, Mark>; rest: RawGroup } {
  const known: Record<string, Mark> = {};
  const rest: RawGroup = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { known, rest };
  let count = 0;
  for (const [id, raw] of Object.entries(value)) {
    if (count >= MAX_ENTRIES) break;
    if (id === '__proto__' || id === '' || id.length > MAX_KEY) continue;
    const mark = validMark(raw);
    if (mark) known[id] = mark;
    else rest[id] = raw;
    count += 1;
  }
  return { known, rest };
}

/** Validates stored JSON: a bad shape is dropped, never thrown; entries this build does not know are kept apart. */
export function parseStoredMarks(raw: string | null | undefined): { map: MarksMap; rest: RawMarks } {
  const empty = () => ({ map: { projects: {}, sessions: {} }, rest: { projects: {}, sessions: {} } });
  if (!raw) return empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty();
  const record = parsed as Record<string, unknown>;
  const projects = parseGroup(record.projects);
  const sessions = parseGroup(record.sessions);
  return { map: { projects: projects.known, sessions: sessions.known }, rest: { projects: projects.rest, sessions: sessions.rest } };
}

export function parseMarks(raw: string | null | undefined): MarksMap {
  return parseStoredMarks(raw).map;
}

function readStored(): { map: MarksMap; rest: RawMarks } {
  try {
    return parseStoredMarks(localStorage.getItem(MARKS_STORAGE_KEY));
  } catch {
    return parseStoredMarks(undefined);
  }
}

function writeStored(map: MarksMap, rest: RawMarks): void {
  try {
    localStorage.setItem(
      MARKS_STORAGE_KEY,
      JSON.stringify({ projects: { ...rest.projects, ...map.projects }, sessions: { ...rest.sessions, ...map.sessions } }),
    );
  } catch {
    // Storage can be blocked or full; the marks then last for this run only.
  }
}

/** Ids of the chats and projects that exist now; undefined while the catalog is not loaded. */
export type LiveIds = { projects: ReadonlySet<string>; sessions: ReadonlySet<string> } | undefined;

export class Marks {
  map = $state<MarksMap>({ projects: {}, sessions: {} });
  private rest: RawMarks = { projects: {}, sessions: {} };
  /** Set by the shell: where the existing chats and projects come from. */
  liveIds: (() => LiveIds) | undefined;

  constructor() {
    const stored = readStored();
    this.map = stored.map;
    this.rest = stored.rest;
  }

  project(id: string): Mark | undefined {
    return Object.hasOwn(this.map.projects, id) ? this.map.projects[id] : undefined;
  }

  session(id: string): Mark | undefined {
    return Object.hasOwn(this.map.sessions, id) ? this.map.sessions[id] : undefined;
  }

  setProject(id: string, mark: Mark | undefined): void {
    this.update('projects', id, mark);
  }

  setSession(id: string, mark: Mark | undefined): void {
    this.update('sessions', id, mark);
  }

  forgetProject(id: string): void {
    this.update('projects', id, undefined);
  }

  forgetSession(id: string): void {
    this.update('sessions', id, undefined);
  }

  private size(group: keyof MarksMap): number {
    return Object.keys(this.map[group]).length + Object.keys(this.rest[group]).length;
  }

  /** Drops marks of chats and projects that are gone; only once the catalog is known. True when something went. */
  private pruneMissing(): boolean {
    const live = this.liveIds?.();
    if (!live) return false;
    const keep = (entries: Record<string, unknown>, ids: ReadonlySet<string>): Record<string, never> =>
      Object.fromEntries(Object.entries(entries).filter(([id]) => ids.has(id))) as Record<string, never>;
    const map: MarksMap = { projects: keep(this.map.projects, live.projects), sessions: keep(this.map.sessions, live.sessions) };
    const rest: RawMarks = { projects: keep(this.rest.projects, live.projects), sessions: keep(this.rest.sessions, live.sessions) };
    const before = this.size('projects') + this.size('sessions');
    const after = Object.keys(map.projects).length + Object.keys(map.sessions).length + Object.keys(rest.projects).length + Object.keys(rest.sessions).length;
    if (after === before) return false;
    this.map = map;
    this.rest = rest;
    writeStored(map, rest);
    return true;
  }

  private update(group: keyof MarksMap, id: string, mark: Mark | undefined): void {
    if (id === '__proto__' || id === '' || id.length > MAX_KEY) return;
    const next = mark === undefined ? undefined : validMark(mark);
    if (mark !== undefined && next === undefined) return;
    const current = Object.hasOwn(this.map[group], id) ? this.map[group][id] : undefined;
    const unknown = Object.hasOwn(this.rest[group], id);
    if (next === undefined && current === undefined && !unknown) return;
    if (next !== undefined && current === undefined && !unknown && this.size(group) >= MAX_ENTRIES) {
      if (!this.pruneMissing() || this.size(group) >= MAX_ENTRIES) return;
    }
    const entries = { ...this.map[group] };
    const rest = { ...this.rest[group] };
    delete rest[id];
    if (next === undefined) delete entries[id];
    else entries[id] = next;
    const map = { ...this.map, [group]: entries };
    this.map = map;
    this.rest = { ...this.rest, [group]: rest };
    writeStored(map, this.rest);
  }
}

export const marks = new Marks();
