import { LabDecodeFailure } from './labErrors';

/**
 * A tiny declarative decoder mirroring the serde attributes on the Rust DTOs:
 * `deny_unknown_fields`, internally tagged enums, `Option<T>` (missing or null)
 * and `#[serde(default)]` (missing only). The lab validates every request with
 * it so UI payload drift fails in the browser exactly as it would in Tauri.
 */
export type Schema =
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'u64' }
  | { readonly kind: 'u32' }
  | { readonly kind: 'json' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'array'; readonly item: Schema }
  /** A string-keyed map (`BTreeMap<String, T>`). */
  | { readonly kind: 'map'; readonly item: Schema }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Field>> }
  | { readonly kind: 'tagged'; readonly tag: string; readonly variants: Readonly<Record<string, Readonly<Record<string, Field>>>> }
  | { readonly kind: 'lazy'; readonly get: () => Schema }
  /** A string with a custom `Deserialize` (for example a harness identity); `reject` returns serde's message. */
  | { readonly kind: 'custom'; readonly reject: (value: string) => string | undefined };

/** `required`: must be present and non-null. `option`: may be missing or null. `default`: may be missing. */
export interface Field {
  readonly schema: Schema;
  readonly presence: 'required' | 'option' | 'default';
}

export const string: Schema = { kind: 'string' };
export const boolean: Schema = { kind: 'boolean' };
export const u64: Schema = { kind: 'u64' };
export const u32: Schema = { kind: 'u32' };
export const json: Schema = { kind: 'json' };
export const datetime: Schema = { kind: 'datetime' };
export const enumOf = (values: readonly string[]): Schema => ({ kind: 'enum', values });
export const arrayOf = (item: Schema): Schema => ({ kind: 'array', item });
export const mapOf = (item: Schema): Schema => ({ kind: 'map', item });
export const lazy = (get: () => Schema): Schema => ({ kind: 'lazy', get });
export const custom = (reject: (value: string) => string | undefined): Schema => ({ kind: 'custom', reject });
export const option = (schema: Schema): Field => ({ schema, presence: 'option' });
export const withDefault = (schema: Schema): Field => ({ schema, presence: 'default' });

type FieldSpec = Readonly<Record<string, Schema | Field>>;

function toFields(spec: FieldSpec): Readonly<Record<string, Field>> {
  return Object.fromEntries(Object.entries(spec).map(([name, value]) => [
    name,
    'presence' in value ? value : { schema: value, presence: 'required' as const },
  ]));
}

export const object = (spec: FieldSpec): Schema => ({ kind: 'object', fields: toFields(spec) });
export const tagged = (tag: string, variants: Readonly<Record<string, FieldSpec>>): Schema => ({
  kind: 'tagged',
  tag,
  variants: Object.fromEntries(Object.entries(variants).map(([name, spec]) => [name, toFields(spec)])),
});

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'object') return 'map';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return `${typeof value} \`${String(value)}\``;
}

function fail(path: string, detail: string): never {
  throw new LabDecodeFailure(path ? `${detail} at \`${path}\`` : detail);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf(values: readonly string[]): string {
  return values.map((item) => `\`${item}\``).join(', ');
}

function decodeFields(fields: Readonly<Record<string, Field>>, value: Record<string, unknown>, path: string, ignore?: string): void {
  for (const key of Object.keys(value)) {
    if (key !== ignore && !Object.hasOwn(fields, key)) fail(path, `unknown field \`${key}\``);
  }
  for (const [name, field] of Object.entries(fields)) {
    const present = Object.hasOwn(value, name);
    const item = value[name];
    const itemPath = path ? `${path}.${name}` : name;
    if (!present) {
      if (field.presence === 'required') fail(path, `missing field \`${name}\``);
      continue;
    }
    if (item === null && field.presence === 'option') continue;
    check(field.schema, item, itemPath);
  }
}

function check(schema: Schema, value: unknown, path: string): void {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') fail(path, `invalid type: ${describe(value)}, expected a string`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, `invalid type: ${describe(value)}, expected a boolean`);
      return;
    case 'u64':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(path, `invalid value: ${describe(value)}, expected u64`);
      }
      return;
    case 'u32':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        fail(path, `invalid value: ${describe(value)}, expected u32`);
      }
      return;
    case 'json':
      return;
    case 'datetime':
      if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || Number.isNaN(Date.parse(value))) {
        fail(path, `input contains invalid characters: ${describe(value)} is not an RFC 3339 date-time`);
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !schema.values.includes(value)) {
        fail(path, `unknown variant ${describe(value)}, expected one of ${oneOf(schema.values)}`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) fail(path, `invalid type: ${describe(value)}, expected a sequence`);
      value.forEach((item, index) => check(schema.item, item, `${path}[${index}]`));
      return;
    case 'map':
      if (!isMap(value)) fail(path, `invalid type: ${describe(value)}, expected a map`);
      for (const [key, item] of Object.entries(value)) check(schema.item, item, path ? `${path}.${key}` : key);
      return;
    case 'object':
      if (!isMap(value)) fail(path, `invalid type: ${describe(value)}, expected a map`);
      decodeFields(schema.fields, value, path);
      return;
    case 'tagged': {
      if (!isMap(value)) fail(path, `invalid type: ${describe(value)}, expected a map`);
      const tag = value[schema.tag];
      if (tag === undefined) fail(path, `missing field \`${schema.tag}\``);
      const variant = typeof tag === 'string' ? schema.variants[tag] : undefined;
      if (variant === undefined) {
        fail(path, `unknown variant ${describe(tag)}, expected one of ${oneOf(Object.keys(schema.variants))}`);
      }
      decodeFields(variant, value, path, schema.tag);
      return;
    }
    case 'lazy':
      check(schema.get(), value, path);
      return;
    case 'custom': {
      if (typeof value !== 'string') fail(path, `invalid type: ${describe(value)}, expected a string`);
      const message = schema.reject(value);
      if (message !== undefined) fail(path, message);
      return;
    }
    default: {
      const exhaustive: never = schema;
      return exhaustive;
    }
  }
}

/**
 * Validates `value` against `schema` and returns it typed as `T`. The cast is
 * the single, checked boundary between untyped IPC arguments and contracts.
 */
export function decode<T>(schema: Schema, value: unknown): T {
  check(schema, value, '');
  return value as T;
}

/** Decodes one named Tauri command argument (`command`, `request`, …). */
export function decodeArgument<T>(args: Readonly<Record<string, unknown>>, name: string, schema: Schema): T {
  if (!Object.hasOwn(args, name) || args[name] === undefined) throw new LabDecodeFailure('missing', name, true);
  try {
    return decode<T>(schema, args[name]);
  } catch (error) {
    if (error instanceof LabDecodeFailure) throw new LabDecodeFailure(error.detail, name);
    throw error;
  }
}
