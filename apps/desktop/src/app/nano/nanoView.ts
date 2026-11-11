import type { NanoAccountStatusV1, NanoCreditsV1, NanoModeLockV1, NanoModeTierV1, NanoModeV1 } from '../../host-api/nanoAccountClient';

/** English source strings; the views translate them through the locale catalog. */
export const NANO_LOCK_COPY: Readonly<Record<NanoModeLockV1, string>> = {
  plan: 'Not in your plan',
  credits: 'No credits left',
  disabled: 'Disabled',
};

export const NANO_TIER_COPY: Readonly<Record<NanoModeTierV1, string>> = {
  mixed: 'Mixed',
  free: 'Free',
  cheap: 'Economy',
  paid: 'Premium',
};

/** Why a mode is locked, or undefined for an available one. */
export function lockCopy(mode: Pick<NanoModeV1, 'available' | 'lockedReason'>): string | undefined {
  if (mode.available) return undefined;
  return NANO_LOCK_COPY[mode.lockedReason ?? 'disabled'];
}

/** Share of the period's credits left, 0..1, or undefined when the plan has no period. */
export function creditsFraction(credits: Pick<NanoCreditsV1, 'balance' | 'included'>): number | undefined {
  if (credits.included === null || credits.included <= 0) return undefined;
  return Math.min(1, Math.max(0, credits.balance / credits.included));
}

/** `low`: about a tenth or less is left; `empty`: nothing is left (a zero or negative balance). */
export function creditsLevel(credits: Pick<NanoCreditsV1, 'balance' | 'included'>): 'ok' | 'low' | 'empty' {
  if (credits.balance <= 0) return 'empty';
  const fraction = creditsFraction(credits);
  return fraction !== undefined && fraction <= 0.1 ? 'low' : 'ok';
}

/** 18250 -> "18,250" (or "18 250" in Russian); `compact` -> "18.3K". */
export function creditsText(value: number, locale: string, compact = false): string {
  return new Intl.NumberFormat(locale, compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}).format(value);
}

/**
 * What "Try again" does when the account is unavailable. A refresh needs a saved
 * credential: while no person is known (the first sign-in failed) it can never
 * recover, so the retry is the sign-in itself.
 */
export function retryAction(status: Pick<NanoAccountStatusV1, 'user'>): 'sign-in' | 'refresh' {
  return status.user === null ? 'sign-in' : 'refresh';
}

/** The one-line state of the sidebar chip. */
export interface NanoChip {
  /** An English source string to translate, or the person's own display name (`translate: false`). */
  readonly label: string;
  /** False for a label that is user data: a display name such as "Free" is never translated. */
  readonly translate: boolean;
  /** Credit balance to show next to the label, when signed in and known. */
  readonly credits: number | undefined;
  readonly tone: 'neutral' | 'ok' | 'warning' | 'danger';
}

export function chipFor(status: NanoAccountStatusV1 | undefined): NanoChip {
  if (status === undefined) return { label: 'Nano account', translate: true, credits: undefined, tone: 'neutral' };
  switch (status.state) {
    case 'signed-out':
      return { label: 'Sign in to Nano', translate: true, credits: undefined, tone: 'neutral' };
    case 'signing-in':
      return { label: 'Signing in…', translate: true, credits: undefined, tone: 'neutral' };
    case 'signed-in': {
      const credits = status.entitlements?.credits;
      const name = status.user?.displayName;
      return {
        label: name ?? 'Nano account',
        translate: name === undefined,
        // A negative balance reads as nothing left.
        credits: credits === undefined ? undefined : Math.max(0, credits.balance),
        tone: credits === undefined ? 'ok' : creditsLevel(credits) === 'ok' ? 'ok' : creditsLevel(credits) === 'low' ? 'warning' : 'danger',
      };
    }
    case 'expired':
      return { label: 'Sign in again', translate: true, credits: undefined, tone: 'warning' };
    case 'unsupported':
      return { label: 'Nano unavailable', translate: true, credits: undefined, tone: 'warning' };
    case 'offline':
      return { label: 'Nano offline', translate: true, credits: undefined, tone: 'warning' };
    default: {
      const exhaustive: never = status.state;
      return exhaustive;
    }
  }
}
