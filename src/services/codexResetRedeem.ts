import { isRecord, readString } from './managementApi';
import { quotaResetInstant } from './quotaTime';

/** T3 Code's namespace for these ids, so both apps name the same account and credit's redemption the same way. */
const REDEEM_NAMESPACE = '6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A UUIDv5-style id for spending one credit on one account. Sending it again
 * after a lost reply names the same redemption, so Codex can't spend a second
 * credit on it.
 */
export async function codexRedeemRequestId(account: string, creditId: string): Promise<string> {
  const namespace = Uint8Array.from(REDEEM_NAMESPACE.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  const name = new TextEncoder().encode(`${account}:${creditId}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  // A SHA-1 digest is 20 bytes, so both of these are always there; the fallback only satisfies the type checker.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The credit a reset spends: the available one that expires soonest, then one
 * that never expires. A credit marked as not applying to the account now is
 * only picked when nothing else is left.
 */
export const nextCodexResetCredit = (payload: unknown, nowMs = Date.now()): { id: string; expiresAt: string } | undefined => {
  const credits = isRecord(payload) && Array.isArray(payload.credits) ? payload.credits.filter(isRecord) : [];
  return credits
    .map((credit) => {
      const expiry = credit.expires_at ?? credit.expiresAt;
      return {
        id: readString(credit, 'id'),
        expiresAt: readString(credit, 'expires_at', 'expiresAt'),
        // Codex lists some credits with a null expiry; one it can't read isn't picked.
        expiresAtMs: expiry === null || expiry === undefined || expiry === ''
          ? Number.POSITIVE_INFINITY
          : quotaResetInstant(expiry) ?? Number.NaN,
        applies: credit.applicable !== false,
        usable: readString(credit, 'reset_type', 'resetType') === 'codex_rate_limits'
          && readString(credit, 'status') === 'available',
      };
    })
    .filter((credit) => credit.usable && Boolean(credit.id) && credit.expiresAtMs > nowMs)
    .sort((left, right) => Number(right.applies) - Number(left.applies)
      || (left.expiresAtMs === right.expiresAtMs ? 0 : left.expiresAtMs < right.expiresAtMs ? -1 : 1))
    .map(({ id, expiresAt }) => ({ id, expiresAt }))[0];
};

const CONSUME_OUTCOMES = ['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'] as const;
export type CodexConsumeOutcome = typeof CONSUME_OUTCOMES[number];

/** Codex's answer to a redemption, or undefined when the reply doesn't say. */
export const codexConsumeOutcome = (body: unknown): CodexConsumeOutcome | undefined => {
  const code = readString(body, 'code');
  return CONSUME_OUTCOMES.find((outcome) => outcome === code);
};

/** A redemption sent without a definite answer back. */
export type UnsettledCodexRedeem = { requestId: string; creditId?: string; atMs: number };

/** How long an unconfirmed redemption is resent as it was, rather than started afresh. */
export const CODEX_UNSETTLED_REDEEM_MS = 3_600_000;
const STORAGE_KEY = 'cpa-gui.codex-unsettled-redeems.v1';
let memory: Record<string, UnsettledCodexRedeem> = {};

// Kept across restarts: quitting after a lost reply mustn't let the next try spend a second credit.
const readRedeems = (): Record<string, UnsettledCodexRedeem> => {
  try {
    if (typeof localStorage === 'undefined') return memory;
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return isRecord(parsed) ? parsed as Record<string, UnsettledCodexRedeem> : {};
  } catch {
    return memory;
  }
};

const writeRedeems = (next: Record<string, UnsettledCodexRedeem>) => {
  memory = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
};

const live = (entry: unknown, nowMs: number): entry is UnsettledCodexRedeem =>
  isRecord(entry) && typeof entry.requestId === 'string' && UUID.test(entry.requestId)
  && typeof entry.atMs === 'number' && nowMs - entry.atMs < CODEX_UNSETTLED_REDEEM_MS
  && (entry.creditId === undefined || typeof entry.creditId === 'string');

/** The unconfirmed redemption kept for a login (see `consumeCodexResetCredit` for the key), if any is still live. */
export const unsettledCodexRedeem = (login: string, nowMs = Date.now()): UnsettledCodexRedeem | undefined => {
  const entry = readRedeems()[login];
  return live(entry, nowMs) ? entry : undefined;
};

export const rememberCodexRedeem = (login: string, redeem: UnsettledCodexRedeem, nowMs = Date.now()) => {
  const kept = Object.entries(readRedeems()).filter(([key, entry]) => key !== login && live(entry, nowMs));
  writeRedeems({ ...Object.fromEntries(kept), [login]: redeem });
};

export const settleCodexRedeem = (login: string) => {
  const { [login]: _settled, ...rest } = readRedeems();
  writeRedeems(rest);
};
