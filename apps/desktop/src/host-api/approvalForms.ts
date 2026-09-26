import type { WorkspaceApprovalField, WorkspaceApprovalForm } from '../../../../contracts/workspace-v15';

/**
 * Native form requests (a Codex MCP elicitation) in the approval contract.
 * The UI edits a draft, checks it with the same rules the adapter applies and
 * answers `approve-once` with a JSON object of opaque field id -> value. The
 * UI Lab host checks answers with `answerMatchesForm`, like the adapter does.
 */

/** Values being edited: inputs keep their text, checkboxes their state. */
export type ApprovalFormDraft = Record<string, string | boolean>;
export type ApprovalFormValue = string | number | boolean;

/** English copy (locale catalog keys) for a field that cannot be sent. */
export const APPROVAL_FIELD_ISSUES = {
  required: 'Fill in this field.',
  tooShort: 'Enter at least {0} characters.',
  tooLong: 'Enter at most {0} characters.',
  email: 'Enter an email address.',
  uri: 'Enter a full address, such as https://example.com.',
  date: 'Enter a date as YYYY-MM-DD.',
  dateTime: 'Enter a date and time with a time zone, such as 2026-09-27T10:00:00Z.',
  number: 'Enter a number.',
  integer: 'Enter a whole number.',
  minimum: 'Enter {0} or more.',
  maximum: 'Enter {0} or less.',
  choice: 'Choose one of the options.',
} as const;

export interface ApprovalFieldIssue {
  readonly message: string;
  readonly args?: readonly (string | number)[];
}

/** Longest text value an adapter accepts without a declared `maxLength`. */
const TEXT_LIMIT = 16 * 1024;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const issue = (message: string, args: readonly (string | number)[] | undefined = undefined): ApprovalFieldIssue =>
  args === undefined ? { message } : { message, args };

function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatIssue(format: Extract<WorkspaceApprovalField, { type: 'text' }>['format'], text: string): ApprovalFieldIssue | undefined {
  switch (format) {
    case undefined:
      return undefined;
    case 'email':
      return /^[^\s@]+@[^\s@]+$/.test(text) ? undefined : issue(APPROVAL_FIELD_ISSUES.email);
    case 'uri':
      return /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(text) ? undefined : issue(APPROVAL_FIELD_ISSUES.uri);
    case 'date':
      return validDate(text) ? undefined : issue(APPROVAL_FIELD_ISSUES.date);
    case 'date-time': {
      const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(text);
      return match?.[1] !== undefined && validDate(match[1]) && Number.isFinite(Date.parse(text))
        ? undefined
        : issue(APPROVAL_FIELD_ISSUES.dateTime);
    }
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

/** Why a typed value cannot be sent for `field`; `undefined` when it can (or is an allowed blank). */
export function valueIssue(field: WorkspaceApprovalField, value: unknown): ApprovalFieldIssue | undefined {
  if (value === undefined || value === null || value === '') return field.required ? issue(APPROVAL_FIELD_ISSUES.required) : undefined;
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') return issue(APPROVAL_FIELD_ISSUES.required);
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength) return issue(APPROVAL_FIELD_ISSUES.tooShort, [field.minLength]);
      const maxLength = field.maxLength ?? TEXT_LIMIT;
      if (length > maxLength) return issue(APPROVAL_FIELD_ISSUES.tooLong, [maxLength]);
      return formatIssue(field.format, value);
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return issue(APPROVAL_FIELD_ISSUES.number);
      if (field.integer && !Number.isSafeInteger(value)) return issue(APPROVAL_FIELD_ISSUES.integer);
      if (field.minimum !== undefined && value < field.minimum) return issue(APPROVAL_FIELD_ISSUES.minimum, [field.minimum]);
      if (field.maximum !== undefined && value > field.maximum) return issue(APPROVAL_FIELD_ISSUES.maximum, [field.maximum]);
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : issue(APPROVAL_FIELD_ISSUES.required);
    case 'choice':
      return typeof value === 'string' && field.options.some((option) => option.id === value)
        ? undefined
        : issue(APPROVAL_FIELD_ISSUES.choice);
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** The editable start state: native defaults, empty text, unchecked boxes. */
export function initialDraft(form: WorkspaceApprovalForm): ApprovalFormDraft {
  const draft: ApprovalFormDraft = {};
  for (const field of form.fields) {
    switch (field.type) {
      case 'text':
        draft[field.id] = field.default ?? '';
        break;
      case 'number':
        draft[field.id] = field.default === undefined ? '' : String(field.default);
        break;
      case 'boolean':
        draft[field.id] = field.default ?? false;
        break;
      case 'choice':
        draft[field.id] = field.default ?? '';
        break;
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  }
  return draft;
}

type Parsed = { value: ApprovalFormValue | undefined } | { issue: ApprovalFieldIssue };

/** Turns one edited value into the typed value that is sent. Blank text is no answer. */
function parseDraftValue(field: WorkspaceApprovalField, raw: string | boolean | undefined): Parsed {
  if (field.type === 'boolean') return { value: raw === true };
  if (typeof raw !== 'string' || raw.trim() === '') return { value: undefined };
  if (field.type !== 'number') return { value: raw };
  const text = raw.trim();
  return NUMBER.test(text) ? { value: Number(text) } : { issue: issue(APPROVAL_FIELD_ISSUES.number) };
}

/** Every field that cannot be sent as edited, by field id. Empty when the answer is valid. */
export function formIssues(form: WorkspaceApprovalForm, draft: ApprovalFormDraft): Record<string, ApprovalFieldIssue> {
  const issues: Record<string, ApprovalFieldIssue> = {};
  for (const field of form.fields) {
    const parsed = parseDraftValue(field, draft[field.id]);
    const problem = 'issue' in parsed ? parsed.issue : valueIssue(field, parsed.value);
    if (problem) issues[field.id] = problem;
  }
  return issues;
}

/** The `respond.text` of an accepted form: answered fields only. Check `formIssues` first. */
export function encodeFormAnswer(form: WorkspaceApprovalForm, draft: ApprovalFormDraft): string | undefined {
  if (form.fields.length === 0) return undefined;
  const answer: Record<string, ApprovalFormValue> = {};
  for (const field of form.fields) {
    const parsed = parseDraftValue(field, draft[field.id]);
    if ('value' in parsed && parsed.value !== undefined) answer[field.id] = parsed.value;
  }
  return JSON.stringify(answer);
}

/** The adapter's check of an accepted answer, for the UI Lab host. */
export function answerMatchesForm(form: WorkspaceApprovalForm, text: string | undefined): boolean {
  if (form.fields.length === 0) return text === undefined || ['', '{}'].includes(text.trim());
  if (text === undefined) return false;
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return false;
  const values = answer as Record<string, unknown>;
  const ids = new Set(form.fields.map((field) => field.id));
  if (Object.keys(values).some((key) => !ids.has(key))) return false;
  return form.fields.every((field) => valueIssue(field, Object.hasOwn(values, field.id) ? values[field.id] : undefined) === undefined);
}
