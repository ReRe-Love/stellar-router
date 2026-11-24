/**
 * Explainable risk scoring for high-impact actions (issue #496).
 *
 * Pure, deterministic and dependency free: the same input always produces the
 * same score, factor breakdown and inputHash, so a retry can be proven to have
 * seen the same input. Nothing here performs I/O — callers (routes, approval)
 * own authorization and persistence.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type RiskFactorId = 'authorization' | 'volume' | 'counterparty' | 'velocity';

export interface RiskActor {
  id: string;
  roles: readonly string[];
}

export interface Counterparty {
  id: string;
  trust: 'trusted' | 'known' | 'unverified' | 'sanctioned';
}

export type HighImpactAction =
  | 'invoice.cancel'
  | 'invoice.refund'
  | 'payout.release'
  | 'settings.update'
  | 'key.rotate';

export interface RiskEvaluationInput {
  action: HighImpactAction;
  actor: RiskActor;
  /** Amount in major units. Finite number >= 0. */
  amount: number;
  asset: string;
  counterparty: Counterparty;
  /** High-impact actions taken by the actor inside the lookback window. */
  recentActionCount: number;
  /** ISO-8601 timestamp. Makes computedAt (and therefore retries) reproducible. */
  requestedAt?: string;
}

export interface RiskFactor {
  id: RiskFactorId;
  label: string;
  /** Inherent severity of the factor, 0..1. */
  severity: number;
  /** Fixed weight of the factor; weights across factors sum to 1. */
  weight: number;
  /** Math.round(severity * weight * 100) — contribution to the final score. */
  contribution: number;
  /** Observed value compared against the threshold, when applicable. */
  observed?: number;
  threshold?: number;
  breached: boolean;
  detail: string;
}

export interface RiskScore {
  /** 0..100, integer. Always equals the sum of factor contributions (capped at 100). */
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  /** Human readable summary of why the score is what it is. */
  reason: string;
  /** Deterministic hash of the canonicalised input — proves a retry saw the same input. */
  inputHash: string;
  computedAt: string;
  version: '1';
}

export type RiskScoringErrorCode = 'INVALID_INPUT' | 'UNSUPPORTED_ACTION' | 'UNAUTHORIZED';

export class RiskScoringError extends Error {
  readonly code: RiskScoringErrorCode;

  constructor(code: RiskScoringErrorCode, message: string) {
    super(message);
    this.name = 'RiskScoringError';
    this.code = code;
    Object.setPrototypeOf(this, RiskScoringError.prototype);
  }
}

/** Roles allowed to request a score for a high-impact action. */
export const RISK_SCORER_ROLES: readonly string[] = ['risk.scorer', 'maintainer', 'admin'];

const ACTIONS: readonly HighImpactAction[] = [
  'invoice.cancel',
  'invoice.refund',
  'payout.release',
  'settings.update',
  'key.rotate',
];

/** Strongest role wins: lower strength == safer actor. Unrecognised roles score 1. */
const ROLE_STRENGTH: Record<string, number> = {
  admin: 0.05,
  maintainer: 0.2,
  operator: 0.45,
  viewer: 0.8,
};

/** Per-action amount cap in major units. 0 => the action is not amount-bearing. */
const VOLUME_LIMITS: Record<HighImpactAction, number> = {
  'invoice.cancel': 1_000,
  'invoice.refund': 5_000,
  'payout.release': 10_000,
  'settings.update': 0,
  'key.rotate': 0,
};

const COUNTERPARTY_TRUST: Record<Counterparty['trust'], { severity: number; breached: boolean }> = {
  trusted: { severity: 0, breached: false },
  known: { severity: 0.25, breached: false },
  unverified: { severity: 0.6, breached: true },
  sanctioned: { severity: 1, breached: true },
};

const WEIGHTS = {
  authorization: 0.3,
  volume: 0.3,
  counterparty: 0.25,
  velocity: 0.15,
} as const;

const VELOCITY_THRESHOLD = 5;
const VELOCITY_SATURATION = 10;

/**
 * Authorization gate for the scoring endpoint itself (fail closed).
 * Throws RiskScoringError('UNAUTHORIZED') when the caller lacks a scorer role.
 */
export function authorizeRiskScorer(caller: RiskActor): void {
  const roles = Array.isArray(caller?.roles) ? caller.roles : [];
  const allowed = roles.some((r) => (RISK_SCORER_ROLES as readonly string[]).includes(r));
  if (!allowed) {
    throw new RiskScoringError(
      'UNAUTHORIZED',
      'Caller must hold risk.scorer, maintainer or admin to evaluate high-impact actions.',
    );
  }
}

function assertValidInput(input: RiskEvaluationInput): void {
  if (!input || typeof input !== 'object') {
    throw new RiskScoringError('INVALID_INPUT', 'input must be an object.');
  }
  if (!ACTIONS.includes(input.action)) {
    throw new RiskScoringError(
      'UNSUPPORTED_ACTION',
      `Unsupported high-impact action "${String(input.action)}".`,
    );
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0) {
    throw new RiskScoringError('INVALID_INPUT', 'amount must be a finite number >= 0.');
  }
  if (typeof input.asset !== 'string' || input.asset.trim() === '') {
    throw new RiskScoringError('INVALID_INPUT', 'asset must be a non-empty string.');
  }
  const actor = input.actor;
  if (
    !actor ||
    typeof actor.id !== 'string' ||
    actor.id.trim() === '' ||
    !Array.isArray(actor.roles) ||
    actor.roles.some((r) => typeof r !== 'string')
  ) {
    throw new RiskScoringError('INVALID_INPUT', 'actor must include a non-empty id and a string[] of roles.');
  }
  const cp = input.counterparty;
  if (
    !cp ||
    typeof cp.id !== 'string' ||
    cp.id.trim() === '' ||
    typeof cp.trust !== 'string' ||
    !(cp.trust in COUNTERPARTY_TRUST)
  ) {
    throw new RiskScoringError(
      'INVALID_INPUT',
      'counterparty must include a non-empty id and a known trust level (trusted|known|unverified|sanctioned).',
    );
  }
  if (
    typeof input.recentActionCount !== 'number' ||
    !Number.isInteger(input.recentActionCount) ||
    input.recentActionCount < 0
  ) {
    throw new RiskScoringError('INVALID_INPUT', 'recentActionCount must be an integer >= 0.');
  }
  if (
    input.requestedAt !== undefined &&
    (typeof input.requestedAt !== 'string' || Number.isNaN(Date.parse(input.requestedAt)))
  ) {
    throw new RiskScoringError('INVALID_INPUT', 'requestedAt must be an ISO-8601 timestamp when provided.');
  }
}

/** Deterministic string hash (FNV-1a, 32-bit) — no crypto dependency, stable across runs. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Key-sorted JSON so the hash does not depend on property insertion order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function authorizationFactor(actor: RiskActor): RiskFactor {
  const strengths = actor.roles
    .map((r) => ROLE_STRENGTH[r])
    .filter((v): v is number => typeof v === 'number');
  const severity = strengths.length > 0 ? Math.min(...strengths) : 1;
  const role =
    Object.keys(ROLE_STRENGTH).find((name) => ROLE_STRENGTH[name] === severity) ?? 'none';
  const detail =
    strengths.length > 0
      ? `Strongest role "${role}" (strength ${severity}).`
      : 'Actor holds no recognised privileged role.';
  return {
    id: 'authorization',
    label: 'Authorization strength',
    severity,
    weight: WEIGHTS.authorization,
    contribution: Math.round(severity * WEIGHTS.authorization * 100),
    breached: severity >= 1,
    detail,
  };
}

function volumeFactor(action: HighImpactAction, amount: number, asset: string): RiskFactor {
  const limit = VOLUME_LIMITS[action];
  if (limit <= 0) {
    return {
      id: 'volume',
      label: 'Volume against action limit',
      severity: 0,
      weight: WEIGHTS.volume,
      contribution: 0,
      observed: amount,
      breached: false,
      detail: `${action} is not amount-bearing; the volume limit does not apply.`,
    };
  }
  const severity = Math.min(amount / limit, 1);
  const breached = amount >= limit;
  return {
    id: 'volume',
    label: 'Volume against action limit',
    severity,
    weight: WEIGHTS.volume,
    contribution: Math.round(severity * WEIGHTS.volume * 100),
    observed: amount,
    threshold: limit,
    breached,
    detail: breached
      ? `Amount ${amount} ${asset} is at or above the ${limit} ${asset} cap for ${action}.`
      : `Amount ${amount} ${asset} of a ${limit} ${asset} cap for ${action}.`,
  };
}

function counterpartyFactor(counterparty: Counterparty): RiskFactor {
  const entry = COUNTERPARTY_TRUST[counterparty.trust];
  return {
    id: 'counterparty',
    label: 'Counterparty trust',
    severity: entry.severity,
    weight: WEIGHTS.counterparty,
    contribution: Math.round(entry.severity * WEIGHTS.counterparty * 100),
    breached: entry.breached,
    detail:
      counterparty.trust === 'sanctioned'
        ? `Counterparty "${counterparty.id}" is on the sanctions list — hard block.`
        : `Counterparty "${counterparty.id}" is ${counterparty.trust}.`,
  };
}

function velocityFactor(recentActionCount: number): RiskFactor {
  const severity = Math.min(recentActionCount / VELOCITY_SATURATION, 1);
  const breached = recentActionCount > VELOCITY_THRESHOLD;
  return {
    id: 'velocity',
    label: 'Action burst velocity',
    severity,
    weight: WEIGHTS.velocity,
    contribution: Math.round(severity * WEIGHTS.velocity * 100),
    observed: recentActionCount,
    threshold: VELOCITY_THRESHOLD,
    breached,
    detail: breached
      ? `Burst: ${recentActionCount} high-impact actions in the lookback window (threshold ${VELOCITY_THRESHOLD}).`
      : `${recentActionCount} high-impact actions in the lookback window (threshold ${VELOCITY_THRESHOLD}).`,
  };
}

/**
 * Score a high-impact action and explain the result.
 *
 * Normal path   -> returns a RiskScore whose `factors` sum exactly to `score`.
 * Failure path  -> throws RiskScoringError with code INVALID_INPUT or UNSUPPORTED_ACTION;
 *                  no partial score is ever returned.
 * Retry path    -> deterministic: identical input yields an identical score,
 *                  identical factors and identical inputHash.
 * Authorization -> not enforced here; call authorizeRiskScorer(caller) first
 *                  (the route does this and maps UNAUTHORIZED to HTTP 403).
 */
export function scoreRisk(input: RiskEvaluationInput): RiskScore {
  assertValidInput(input);

  const factors: RiskFactor[] = [
    authorizationFactor(input.actor),
    volumeFactor(input.action, input.amount, input.asset),
    counterpartyFactor(input.counterparty),
    velocityFactor(input.recentActionCount),
  ];

  const score = Math.min(
    100,
    factors.reduce((sum, f) => sum + f.contribution, 0),
  );
  const level: RiskLevel =
    score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  const breached = factors.filter((f) => f.breached).sort((a, b) => b.contribution - a.contribution);
  const reason =
    breached.length > 0
      ? breached.map((f) => `${f.label}: ${f.detail}`).join(' | ')
      : 'No factor crossed its threshold.';

  return {
    score,
    level,
    factors,
    reason,
    inputHash: fnv1a(canonicalize(input)),
    computedAt: input.requestedAt ?? new Date().toISOString(),
    version: '1',
  };
}
