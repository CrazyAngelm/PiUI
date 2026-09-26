import type {
  AcpAgentDescriptorV1,
  AcpAgentEntryV1,
  CommandLineV1,
  HarnessState,
} from '../../../../../contracts/harness-registry-v1';
import { ACP_AGENT_ID, checkAcpDescriptor, parseAcpDescriptor, type AcpDescriptorCheck } from '../../host-api/acpDescriptor';

/**
 * Presentation helpers for Settings → Harnesses (ADR-034). Every returned
 * string is an English locale key; components translate it with `$t`.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function stateBadge(state: HarnessState, safeMode: boolean): { label: string; tone: BadgeTone } {
  switch (state) {
    case 'ready': return { label: 'Ready', tone: 'success' };
    // Safe mode starts no agent program, so nothing is being checked.
    case 'checking': return safeMode ? { label: 'Not checked', tone: 'neutral' } : { label: 'Checking…', tone: 'info' };
    case 'not-installed': return { label: 'Not installed', tone: 'neutral' };
    case 'unsupported-version': return { label: 'Unsupported version', tone: 'warning' };
    case 'unverified-version': return { label: 'Unverified version', tone: 'warning' };
    case 'sign-in-required': return { label: 'Sign-in required', tone: 'warning' };
    case 'untrusted': return { label: 'Needs review', tone: 'warning' };
    case 'unavailable': return { label: 'Unavailable', tone: 'danger' };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * A readable single line for review. Quoting is for display only: PiUI starts
 * the program directly with these arguments and never uses a shell.
 */
export function commandLineText(line: CommandLineV1): string {
  return [line.program, ...line.args].map((part) => (part === '' || /[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');
}

/** The version line of an ACP agent: `[template, parameters]` for `$t`. */
export function versionNote(agent: AcpAgentEntryV1): [string, string[]] | undefined {
  const version = agent.version ?? '';
  switch (agent.versionStatus) {
    case undefined: return undefined;
    case 'verified': return ['{0}, tested with PiUI', [version]];
    case 'no-verified-range':
    case 'newer':
      return agent.confirmedVersion === agent.version
        ? ['{0}, not verified by PiUI; you confirmed this version', [version]]
        : [agent.versionStatus === 'newer' ? '{0}, newer than the versions tested with PiUI' : '{0}, not verified by PiUI', [version]];
    case 'older': return ['{0}, older than the versions tested with PiUI', [version]];
    case 'unrecognized': return ['The version output was not recognized', []];
    case 'probe-failed': return ['The version check did not finish', []];
    default: {
      const exhaustive: never = agent.versionStatus;
      return exhaustive;
    }
  }
}

// A plugin's agent (ADR-032) is trusted like one you added: by its exact command line.
export const canTrust = (agent: AcpAgentEntryV1): boolean => agent.source !== 'built-in' && agent.state === 'untrusted' && agent.commandLine !== undefined;
export const canConfirmVersion = (agent: AcpAgentEntryV1): boolean => agent.state === 'unverified-version' && agent.version !== undefined;
export const canChooseSecrets = (agent: AcpAgentEntryV1): boolean => agent.trusted && agent.secretEnvironment.length > 0;
export const canRemove = (agent: AcpAgentEntryV1): boolean => agent.source === 'user';

/** Environment names passed without a confirmation, and secret-like ones with their decision. */
export function environmentGroups(agent: AcpAgentEntryV1): { plain: string[]; allowed: string[]; withheld: string[] } {
  const secrets = new Set(agent.secretEnvironment);
  const names = agent.descriptor.environment ?? [];
  return {
    plain: names.filter((name) => !secrets.has(name)),
    allowed: names.filter((name) => secrets.has(name) && agent.allowedSecrets.includes(name)),
    withheld: names.filter((name) => secrets.has(name) && !agent.allowedSecrets.includes(name)),
  };
}

// ---- Add ACP agent form ---------------------------------------------------------

export interface AcpDescriptorForm {
  id: string;
  displayName: string;
  program: string;
  /** One argument per line. */
  args: string;
  versionArgs: string;
  versionPattern: string;
  verifiedMinimum: string;
  verifiedCeiling: string;
  /** Names separated by lines, commas or spaces. */
  environment: string;
  authHint: string;
  docsUrl: string;
  noLoadSession: boolean;
  noModels: boolean;
  noModes: boolean;
  noMcpHttp: boolean;
}

export function emptyDescriptorForm(): AcpDescriptorForm {
  return {
    id: '', displayName: '', program: '', args: '', versionArgs: '--version', versionPattern: '',
    verifiedMinimum: '', verifiedCeiling: '', environment: '', authHint: '', docsUrl: '',
    noLoadSession: false, noModels: false, noModes: false, noMcpHttp: false,
  };
}

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

/** The descriptor object a form describes; `checkAcpDescriptor` (and the host) validate it. */
export function descriptorFromForm(form: AcpDescriptorForm): Record<string, unknown> {
  const args = lines(form.args);
  const environment = form.environment.split(/[\s,]+/).filter((name) => name !== '');
  const pattern = form.versionPattern.trim();
  const minimum = form.verifiedMinimum.trim();
  const ceiling = form.verifiedCeiling.trim();
  const capabilities = {
    ...(form.noLoadSession ? { loadSession: false } : {}),
    ...(form.noModels ? { models: false } : {}),
    ...(form.noModes ? { modes: false } : {}),
    ...(form.noMcpHttp ? { mcpHttp: false } : {}),
  };
  return {
    schemaVersion: 1,
    id: form.id.trim(),
    displayName: form.displayName.trim(),
    command: { program: form.program.trim(), ...(args.length > 0 ? { args } : {}) },
    version: {
      args: lines(form.versionArgs),
      ...(pattern === '' ? {} : { pattern }),
      ...(minimum === '' && ceiling === '' ? {} : { verified: { minimum, ceiling } }),
    },
    ...(environment.length > 0 ? { environment } : {}),
    ...(form.authHint.trim() === '' ? {} : { authHint: form.authHint.trim() }),
    ...(form.docsUrl.trim() === '' ? {} : { docsUrl: form.docsUrl.trim() }),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

export function formFromDescriptor(descriptor: AcpAgentDescriptorV1): AcpDescriptorForm {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    program: descriptor.command.program,
    args: (descriptor.command.args ?? []).join('\n'),
    versionArgs: descriptor.version.args.join('\n'),
    versionPattern: descriptor.version.pattern ?? '',
    verifiedMinimum: descriptor.version.verified?.minimum ?? '',
    verifiedCeiling: descriptor.version.verified?.ceiling ?? '',
    environment: (descriptor.environment ?? []).join('\n'),
    authHint: descriptor.authHint ?? '',
    docsUrl: descriptor.docsUrl ?? '',
    noLoadSession: descriptor.capabilities?.loadSession === false,
    noModels: descriptor.capabilities?.models === false,
    noModes: descriptor.capabilities?.modes === false,
    noMcpHttp: descriptor.capabilities?.mcpHttp === false,
  };
}

export function formJson(form: AcpDescriptorForm): string {
  return JSON.stringify(descriptorFromForm(form), null, 2);
}

/**
 * Pasted JSON as a form, only when the form can show every value exactly
 * (never silently drop or rewrite a field); otherwise keep editing JSON.
 */
export function formFromJson(text: string): { form: AcpDescriptorForm } | { error: string } {
  const parsed = parseAcpDescriptor(text);
  if (!parsed.ok) return { error: parsed.message };
  const form = formFromDescriptor(parsed.descriptor);
  const again = checkAcpDescriptor(descriptorFromForm(form));
  if (!again.ok || JSON.stringify(again.descriptor) !== JSON.stringify(parsed.descriptor)) {
    return { error: 'This descriptor has values the form cannot show. Keep editing it as JSON.' };
  }
  return { form };
}

/** The descriptor to add from the active editor, or the first problem to show. */
export function draftDescriptor(mode: 'form' | 'json', form: AcpDescriptorForm, json: string): AcpDescriptorCheck {
  if (mode === 'json') return parseAcpDescriptor(json);
  const value = descriptorFromForm(form);
  const id = typeof value.id === 'string' ? value.id : '';
  if (!ACP_AGENT_ID.test(id)) {
    return { ok: false, problem: 'malformed', message: 'The ID must be 1-32 lowercase letters, digits and single inner hyphens.' };
  }
  return checkAcpDescriptor(value);
}
