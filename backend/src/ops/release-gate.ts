/**
 * Release readiness gate (issue #497).
 *
 * A release may only ship when BOTH:
 *   - migration safety evidence passes      (backend/src/db/migration-safety.ts)
 *   - incident recovery evidence passes     (backend/src/ops/incident-recovery-checks.ts)
 *
 * A missing result (check never ran / threw) is treated exactly like a failing
 * result: the gate fails closed. Authorization is enforced before any evidence
 * is evaluated.
 */

import { checkMigrationSafety } from '../db/migration-safety';
import type { GateCheck, MigrationSafetyReport } from '../db/migration-safety';
import { checkIncidentRecovery } from './incident-recovery-checks';
import type { RecoveryEvidenceReport } from './incident-recovery-checks';

export interface ReleaseActor {
  id: string;
  roles: readonly string[];
}

/** Roles allowed to run the release gate. */
export const RELEASE_GATE_ROLES: readonly string[] = ['release.manager', 'admin'];

export type GateCheckName = 'migration-safety' | 'incident-recovery';

export interface GateResultEntry {
  name: GateCheckName;
  status: 'pass' | 'fail' | 'missing' | 'error';
  checks: GateCheck[];
  detail: string;
}

export interface ReleaseGateReport {
  releaseId: string;
  /** True only when authorization succeeded and every check passed. */
  ready: boolean;
  checkedAt: string;
  actor: { id: string; authorized: boolean } | null;
  results: GateResultEntry[];
  /** Machine-readable reasons the gate refused (empty when `ready`). */
  blockers: string[];
}

export type ReleaseGateErrorCode = 'UNAUTHORIZED' | 'GATE_FAILED';

export class ReleaseGateError extends Error {
  readonly code: ReleaseGateErrorCode;
  readonly report: ReleaseGateReport | null;

  constructor(code: ReleaseGateErrorCode, message: string, report: ReleaseGateReport | null = null) {
    super(message);
    this.name = 'ReleaseGateError';
    this.code = code;
    this.report = report;
    Object.setPrototypeOf(this, ReleaseGateError.prototype);
  }
}

export interface ReleaseGateDeps {
  migrationSafety?: typeof checkMigrationSafety;
  incidentRecovery?: typeof checkIncidentRecovery;
  migrationDeps?: Parameters<typeof checkMigrationSafety>[0];
  recoveryDeps?: Parameters<typeof checkIncidentRecovery>[0];
}

function isAuthorized(actor: ReleaseActor): boolean {
  return (
    !!actor &&
    Array.isArray(actor.roles) &&
    actor.roles.some((r) => (RELEASE_GATE_ROLES as readonly string[]).includes(r))
  );
}

/**
 * Run the release gate.
 *
 * Normal path    -> resolves with `ready: true` and every entry `pass`.
 * Failure path   -> resolves with `ready: false` and `blockers` populated when
 *                   any check fails, is missing, or throws (`status: 'error'`).
 * Retry path     -> deterministic: with fixed evidence the report is identical
 *                   on every run (tests assert deep equality).
 * Authorization  -> throws `ReleaseGateError('UNAUTHORIZED')` before any
 *                   evidence is touched when the actor lacks a gate role.
 */
export async function runReleaseGate(options: {
  releaseId: string;
  actor: ReleaseActor;
  deps?: ReleaseGateDeps;
  now?: () => string;
}): Promise<ReleaseGateReport> {
  const { releaseId, actor } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const deps = options.deps ?? {};

  if (!releaseId || typeof releaseId !== 'string') {
    throw new ReleaseGateError('GATE_FAILED', 'releaseId is required to run the release gate.');
  }

  if (!isAuthorized(actor)) {
    throw new ReleaseGateError(
      'UNAUTHORIZED',
      `Actor "${actor?.id ?? 'unknown'}" lacks ${RELEASE_GATE_ROLES.join('/')} role; release gate refused.`,
    );
  }

  const blockers: string[] = [];
  const results: GateResultEntry[] = [];

  // --- Gate 1: migration safety -------------------------------------------
  try {
    const report: MigrationSafetyReport = await (deps.migrationSafety ?? checkMigrationSafety)(
      deps.migrationDeps ?? { loadEvidence: async () => ({ ...emptyMigrationEvidence }) },
      now,
    );
    results.push(entryFromReport('migration-safety', report, blockers));
  } catch (err) {
    results.push(entryFromError('migration-safety', err, blockers));
  }

  // --- Gate 2: incident recovery ------------------------------------------
  try {
    const report: RecoveryEvidenceReport = await (deps.incidentRecovery ?? checkIncidentRecovery)(
      deps.recoveryDeps ?? { loadEvidence: async () => ({ ...emptyRecoveryEvidence }) },
      now,
    );
    results.push(entryFromReport('incident-recovery', report, blockers));
  } catch (err) {
    results.push(entryFromError('incident-recovery', err, blockers));
  }

  return {
    releaseId,
    ready: blockers.length === 0,
    checkedAt: now(),
    actor: { id: actor.id, authorized: true },
    results,
    blockers,
  };
}

const emptyMigrationEvidence = {
  pendingMigrations: [] as string[],
  rollbackScriptExists: {} as Record<string, boolean>,
  expectedSchemaChecksum: '',
  actualSchemaChecksum: '',
};

const emptyRecoveryEvidence = {
  lastRestoreDrillAt: null as string | null,
  lastIncidentRunbookCompleted: false,
  lastRestoreDrillDurationSeconds: null as number | null,
  lastRestoreDrillEvidenceRef: null as string | null,
};

function entryFromReport(
  name: GateCheckName,
  report: { ok: boolean; checks: GateCheck[]; checkedAt: string },
  blockers: string[],
): GateResultEntry {
  const failed = report.checks.filter((c) => c.status !== 'pass');
  if (!report.ok || failed.length > 0) {
    // A `missing` status means evidence never materialised — fail closed.
    const missing = failed.filter((c) => c.status === 'missing');
    for (const c of failed) {
      blockers.push(`${name}/${c.id}: ${c.status} — ${c.detail}`);
    }
    return {
      name,
      status: failed.length === missing.length && missing.length > 0 ? 'missing' : 'fail',
      checks: report.checks,
      detail: `${failed.length} check(s) not passing.`,
    };
  }
  return {
    name,
    status: 'pass',
    checks: report.checks,
    detail: 'All checks passed.',
  };
}

function entryFromError(name: GateCheckName, err: unknown, blockers: string[]): GateResultEntry {
  const message = (err as Error)?.message ?? String(err);
  blockers.push(`${name}: error — ${message}`);
  return {
    name,
    status: 'error',
    checks: [],
    detail: message,
  };
}
