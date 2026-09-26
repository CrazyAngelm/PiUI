// The JSON transform node of the pipeline-pack example, as a pure function:
// no files, no network, no clock. The backend and the tests call it.

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Plain text is not a JSON object.
    }
  }
  return undefined;
}

function fieldList(text) {
  return String(text ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function renames(text) {
  const pairs = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [from, to, ...rest] = trimmed.split('=').map((part) => part.trim());
    if (rest.length > 0 || !FIELD.test(from ?? '') || !FIELD.test(to ?? '')) {
      throw new Error(`“${trimmed}” is not an old=new pair of field names.`);
    }
    pairs.push([from, to]);
  }
  return pairs;
}

/**
 * Reshapes JSON results.
 * - `source`: `dependencies` merges every connected step's JSON result (a
 *   `data` object, or `text` that is one JSON object) in the order PiUI
 *   lists them; `inputs` reads the run inputs.
 * - `pick`: comma-separated fields to keep (empty keeps all).
 * - `rename`: one `old=new` pair per line.
 * - `wrap`: put the result under this field.
 */
export function transformJson({ config = {}, inputs = {}, dependencies = {} }) {
  const merged = {};
  if ((config.source ?? 'dependencies') === 'inputs') {
    Object.assign(merged, asObject(inputs) ?? {});
  } else {
    for (const dependency of Object.values(dependencies)) {
      Object.assign(merged, asObject(dependency?.data) ?? asObject(dependency?.text) ?? {});
    }
  }
  const pick = fieldList(config.pick);
  const invalid = pick.find((name) => !FIELD.test(name));
  if (invalid !== undefined) throw new Error(`“${invalid}” is not a field name.`);
  let result = pick.length === 0 ? { ...merged } : Object.fromEntries(pick.filter((name) => name in merged).map((name) => [name, merged[name]]));
  for (const [from, to] of renames(config.rename)) {
    if (from in result) {
      const { [from]: value, ...rest } = result;
      result = { ...rest, [to]: value };
    }
  }
  const wrap = String(config.wrap ?? '').trim();
  if (wrap === '') return result;
  if (!FIELD.test(wrap)) throw new Error(`“${wrap}” is not a field name.`);
  return { [wrap]: result };
}
