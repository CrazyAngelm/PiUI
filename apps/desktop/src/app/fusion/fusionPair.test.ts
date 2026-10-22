import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';
import { DEFAULT_FUSION_OPTIONS, FusionError, type FusionRefusalV1 } from '../../host-api/fusionClient';
import {
  FUSION_PERMISSION_CHOICES,
  defaultPair,
  fusionErrorText,
  isFusionLead,
  isFusionSidekick,
  pairKey,
  refusalCopy,
  rememberablePair,
  restorePair,
  roleLabel,
  withHarness,
  withModel,
  withOptions,
  withPermission,
  withRole,
  withServiceTier,
  withThinkingLevel,
} from './fusionPair';
import {
  briefStateLabel,
  deliveryLabel,
  reportStatusLabel,
  roundOutcomeLabel,
  roundStateLabel,
  sidekickStateDot,
  sidekickStateLabel,
} from './fusionState';

const REFUSALS: FusionRefusalV1[] = [
  'lead-harness-unsupported',
  'sidekick-harness-unsupported',
  'explicit-modes-required',
  'sidekick-exceeds-lead',
  'sidekick-needs-full-access',
  'codex-sandbox-unverified',
  'read-only-lead',
];

describe('default Fusion pair', () => {
  it('prefers a cross-vendor pair with explicit permission modes', () => {
    expect(defaultPair(['claude-code', 'codex', 'pi'])).toEqual({
      lead: { harness: 'claude-code', permissionMode: 'workspace-write' },
      sidekick: { harness: 'codex', permissionMode: 'workspace-write' },
      options: DEFAULT_FUSION_OPTIONS,
    });
    expect(defaultPair(['codex', 'pi'])?.sidekick.harness).toBe('pi');
  });

  it('puts both roles at full access for a Pi sidekick, which has no sandbox', () => {
    const pair = defaultPair(['codex', 'pi']);
    expect(pair?.lead.permissionMode).toBe('full-access');
    expect(pair?.sidekick.permissionMode).toBe('full-access');
  });

  it('falls back to the same harness for both roles and to nothing without a lead', () => {
    expect(defaultPair(['codex'])).toMatchObject({ lead: { harness: 'codex' }, sidekick: { harness: 'codex' } });
    expect(defaultPair(['pi', 'hermes'])).toBeUndefined();
    expect(defaultPair([])).toBeUndefined();
  });

  it('never shares the default options object', () => {
    const pair = defaultPair(['claude-code']);
    expect(pair?.options).toEqual(DEFAULT_FUSION_OPTIONS);
    expect(pair?.options).not.toBe(DEFAULT_FUSION_OPTIONS);
  });

  it('knows which harnesses can take which role', () => {
    expect(isFusionLead('claude-code') && isFusionLead('codex')).toBe(true);
    expect(isFusionLead('pi')).toBe(false);
    expect(isFusionSidekick('pi')).toBe(true);
    expect(isFusionSidekick('hermes')).toBe(false);
  });
});

describe('role edits', () => {
  const model = { id: 'm1', name: 'M1', thinkingLevels: ['low', 'high'] };

  it('drops the model and reasoning of another harness', () => {
    const role = withThinkingLevel(withModel({ harness: 'codex', permissionMode: 'read-only' }, model, false), 'high');
    expect(role).toEqual({ harness: 'codex', permissionMode: 'read-only', model, thinkingLevel: 'high' });
    expect(withHarness(role, 'codex')).toBe(role);
    expect(withHarness(role, 'pi')).toEqual({ harness: 'pi', permissionMode: 'read-only' });
  });

  it('keeps a reasoning level only when the new model offers it', () => {
    const role = withThinkingLevel(withModel({ harness: 'codex', permissionMode: 'native' }, model, false), 'high');
    expect(withModel(role, { id: 'm2', name: 'M2', thinkingLevels: ['high'] }, false).thinkingLevel).toBe('high');
    expect(withModel(role, { id: 'm3', name: 'M3' }, false).thinkingLevel).toBeUndefined();
    expect(withModel(role, undefined, false)).toEqual({ harness: 'codex', permissionMode: 'native' });
    expect(withThinkingLevel(role, '').thinkingLevel).toBeUndefined();
  });

  it('keeps fast only for fast-capable models and drops it on harness changes', () => {
    const fastRole = withServiceTier(withModel({ harness: 'codex', permissionMode: 'native' }, { id: 'm1', name: 'M1' }, true), true);
    expect(fastRole.serviceTier).toBe('fast');
    expect(withModel(fastRole, { id: 'm2', name: 'M2' }, false).serviceTier).toBeUndefined();
    expect(withHarness(fastRole, 'pi').serviceTier).toBeUndefined();
    expect(withModel(fastRole, { id: 'm3', name: 'M3' }, true).serviceTier).toBe('fast');
    expect(withThinkingLevel(fastRole, 'high').serviceTier).toBe('fast');
  });

  it('changes one role or the options without touching the rest', () => {
    const pair = defaultPair(['claude-code', 'codex'])!;
    const next = withRole(pair, 'sidekick', withPermission(pair.sidekick, 'read-only'));
    expect(next.lead).toBe(pair.lead);
    expect(next.sidekick.permissionMode).toBe('read-only');
    expect(withOptions(pair, { pushback: true }).options).toEqual({ ...DEFAULT_FUSION_OPTIONS, pushback: true });
    expect(pairKey(next)).not.toBe(pairKey(pair));
    expect(pairKey(withRole(pair, 'lead', { ...pair.lead }))).toBe(pairKey(pair));
    const fastLead = withServiceTier(withModel(pair.lead, { id: 'm', name: 'Model' }, true), true);
    expect(pairKey(withRole(pair, 'lead', fastLead))).not.toBe(pairKey(pair));
  });
});

describe('remembered pair', () => {
  const available = ['claude-code', 'codex', 'pi'] as const;

  it('round-trips roles and options but not models', () => {
    const pair = defaultPair(available)!;
    const withModelPair = withRole(withOptions(pair, { pushback: true, briefPolicy: 'outline' }), 'lead', withModel(pair.lead, { id: 'm', name: 'M' }, false));
    const restored = restorePair(rememberablePair(withModelPair), available);
    expect(restored).toEqual({ ...withModelPair, lead: { harness: pair.lead.harness, permissionMode: pair.lead.permissionMode } });
  });

  it('rejects garbage, unavailable harnesses and a Pi lead', () => {
    const pair = defaultPair(available)!;
    expect(restorePair(null, available)).toBeUndefined();
    expect(restorePair('{not json', available)).toBeUndefined();
    expect(restorePair('[]', available)).toBeUndefined();
    expect(restorePair(rememberablePair(pair), ['claude-code'])).toBeUndefined();
    expect(restorePair(JSON.stringify({ ...JSON.parse(rememberablePair(pair)), lead: { harness: 'pi', permissionMode: 'full-access' } }), available)).toBeUndefined();
    expect(restorePair(JSON.stringify({ ...JSON.parse(rememberablePair(pair)), sidekick: { harness: 'codex', permissionMode: 'root' } }), available)).toBeUndefined();
  });
});

describe('refusal copy', () => {
  it('words every host refusal in the locale catalog, in both languages', () => {
    for (const refusal of REFUSALS) {
      const { title, hint } = refusalCopy(refusal);
      expect(title, refusal).not.toBe('');
      expect(hint, refusal).not.toBe('');
      expect(translate(title, 'ru'), title).not.toBe(title);
      expect(translate(hint, 'ru'), hint).not.toBe(hint);
    }
    expect(new Set(REFUSALS.map((refusal) => refusalCopy(refusal).title)).size).toBe(REFUSALS.length);
  });

  it('names the roles', () => {
    expect(roleLabel('lead')).toBe('Lead');
    expect(roleLabel('sidekick')).toBe('Sidekick');
    expect(translate(roleLabel('lead'), 'ru')).not.toBe('Lead');
    expect(translate(roleLabel('sidekick'), 'ru')).not.toBe('Sidekick');
  });
});

describe('error copy', () => {
  it('maps each Fusion error code to a translated message without host text', () => {
    for (const code of ['SAFE_MODE', 'INVALID_ARGUMENT', 'NOT_FOUND', 'CONFLICT', 'NOT_SUPPORTED', 'IO_ERROR', 'SIGN_IN_REQUIRED', 'unknown'] as const) {
      const message = fusionErrorText(new FusionError(code));
      expect(translate(message, 'ru'), code).not.toBe(message);
    }
    expect(fusionErrorText({ code: 'NOT_FOUND', message: 'secret path' })).toBe(fusionErrorText(new FusionError('NOT_FOUND')));
    expect(fusionErrorText(new Error('boom'))).toBe(fusionErrorText(new FusionError('unknown')));
  });
});

describe('fusion copy catalog', () => {
  it('translates permission and state labels', () => {
    const keys = [
      ...FUSION_PERMISSION_CHOICES.flatMap((choice) => [choice.label, choice.description]),
      ...(['none', 'idle', 'working', 'waitingApproval', 'stopping', 'unavailable'] as const).map(sidekickStateLabel),
      ...(['queued', 'running', 'waitingApproval', 'stopping', 'finished', 'uncertain'] as const).map(roundStateLabel),
      ...(['completed', 'interrupted', 'failed', 'no-answer', 'uncertain'] as const).map(roundOutcomeLabel),
      ...(['done', 'partial', 'blocked', 'needs-decision', 'unknown'] as const).map(reportStatusLabel),
      ...(['active', 'reported', 'closed', 'stopped'] as const).map(briefStateLabel),
      ...(['queued', 'sending', 'sent', 'uncertain', 'withdrawn'] as const).map(deliveryLabel),
    ];
    for (const key of keys) expect(translate(key, 'ru'), key).not.toBe(key);
  });

  it('shows live work as running and a lost sidekick as failed', () => {
    expect(sidekickStateDot('working')).toBe('running');
    expect(sidekickStateDot('unavailable')).toBe('failed');
    expect(sidekickStateDot('none')).toBe('offline');
  });
});
