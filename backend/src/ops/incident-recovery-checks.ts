/**
 * Incident recovery evidence checks for the release gate (issue #497).
 *
 * Verifies that a recovery path was actually exercised — not merely configured
 * — before a release is allowed out. Pure with respect to its `deps`.
 */

import type { GateCheck } from '../db/migration-safety';
import type { CheckStatus } from '../db/migration-safety';

export interface RecoveryEvidenceReport {
  kind: 'incident-recovery';
  /** True only when every check `pass`es. A single `missing`/`fail` makes it false. */
  ok: boolean;
  checkedAt: string;
  checks: GateCheck[];
}

export interface RecoveryEvidence {
  /** ISO timestamp of the most recent successful restore drill, or null if never run. */
  lastRestoreDrillAt: string | null;
  /** Whether the runbook for the previous incident was followed end to end. */
  lastIncidentRunbookCompleted: boolean;
  /** Seconds the last restore drill took; null when there is no drill to report. */
  lastRestoreDrillDurationSeconds: number | null;
  /** Evidence file/link produced by the last drill (path or URL). */
  lastRestoreDrillEvidenceRef: string | null;
}

export interface RecoveryEvidenceDeps {
  loadEvidence(): Promise<RecoveryEvidence>;
  /** Max drill age in days; drills older than this do not count. */
  maxDrillAgeDays?: number;
  /** Max acceptable restore time in seconds. */
  maxRestoreSeconds?: number;
}

const DEFAULT_MAX_DRILL_AGE_DAYS = 30;
const DEFAULT_MAX_RESTORE_SECONDS = 900;

export type RecoveryCheckErrorCode = 'EVIDENCE_UNAVAILABLE' | 'EVIDENCE_MALFORMED';

export class RecoveryCheckError extends Error {
  readonly code: RecoveryCheckErrorCode;

  constructor(code: RecoveryCheckErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryCheckError';
    this.code = code;
    Object.setPrototypeOf(this, RecoveryCheckError.prototype);
  }
}

function allPassed(checks: GateCheck[]): boolean {
  return checks.every((c) => c.status === 'pass');
}

/**
 * Evaluate incident recovery evidence for a release.
 *
 * Checks (in order):
 *  1. `restore-drill-freshness` — a restore drill exists and is recent enough.
 *  2. `restore-drill-duration`  — the drill finished inside the RTO budget.
 *  3. `restore-drill-evidence`  — the drill produced a referenceable artefact.
 *  4. `incident-runbook`        — the last incident runbook was completed.
 *
 * Failure path: throws `RecoveryCheckError` when evidence cannot be loaded or
 * is malformed — the gate maps a thrown evaluation to a failing result.
 */
export async function checkIncidentRecovery(
  deps: RecoveryEvidenceDeps,
  now: () => string = () => new Date().toISOString(),
): Promise<RecoveryEvidenceReport> {
  let evidence: RecoveryEvidence;
  try {
    evidence = await deps.loadEvidence();
  } catch (err) {
    throw new RecoveryCheckError(
      'EVIDENCE_UNAVAILABLE',
      `Recovery evidence could not be loaded: ${(err as Error).message}`,
    );
  }

  if (
    !evidence ||
    typeof evidence.lastRestoreDrillAt !== 'string' &&
      evidence.lastRestoreDrillAt !== null ||
    typeof evidence.lastIncidentRunbookCompleted !== 'boolean' ||
    (typeof evidence.lastRestoreDrillDurationSeconds !== 'number' &&
      evidence.lastRestoreDrillDurationSeconds !== null) ||
    (typeof evidence.lastRestoreDrillEvidenceRef !== 'string' &&
      evidence.lastRestoreDrillEvidenceRef !== null)
  ) {
    throw new RecoveryCheckError(
      'EVIDENCE_MALFORMED',
      'Recovery evidence is missing required fields (drill timestamp, runbook flag, duration, reference).',
    );
  }

  const maxAgeDays = deps.maxDrillAgeDays ?? DEFAULT_MAX_DRILL_AGE_DAYS;
  const maxRestoreSeconds = deps.maxRestoreSeconds ?? DEFAULT_MAX_RESTORE_SECONDS;
  const nowMs = Date.parse(now());
  const drillMs = evidence.lastRestoreDrillAt ? Date.parse(evidence.lastRestoreDrillAt) : NaN;

  const checks: GateCheck[] = [];

  let freshnessStatus: CheckStatus;
  let freshnessDetail: string;
  if (evidence.lastRestoreDrillAt === null || Number.isNaN(drillMs)) {
    freshnessStatus = 'missing';
    freshnessDetail = 'No restore drill on record — recovery has never been exercised.';
  } else if (Number.isNaN(nowMs)) {
    freshnessStatus = 'missing';
    freshnessDetail = 'Current time is not a valid ISO-8601 timestamp.';
  } else if (nowMs - drillMs > maxAgeDays * 86_400_000) {
    freshnessStatus = 'fail';
    freshnessDetail = `Last restore drill ${evidence.lastRestoreDrillAt} is older than ${maxAgeDays} days.`;
  } else {
    freshnessStatus = 'pass';
    freshnessDetail = `Last restore drill ${evidence.lastRestoreDrillAt} is within ${maxAgeDays} days.`;
  }
  checks.push({
    id: 'restore-drill-freshness',
    label: 'Restore drill is recent',
    status: freshnessStatus,
    detail: freshnessDetail,
  });

  let durationStatus: CheckStatus;
  let durationDetail: string;
  if (evidence.lastRestoreDrillDurationSeconds === null) {
    durationStatus = 'missing';
    durationDetail = 'No restore drill duration recorded.';
  } else if (evidence.lastRestoreDrillDurationSeconds > maxRestoreSeconds) {
    durationStatus = 'fail';
    durationDetail = `Restore drill took ${evidence.lastRestoreDrillDurationSeconds}s (budget ${maxRestoreSeconds}s).`;
  } else {
    durationStatus = 'pass';
    durationDetail = `Restore drill took ${evidence.lastRestoreDrillDurationSeconds}s (budget ${maxRestoreSeconds}s).`;
  }
  checks.push({
    id: 'restore-drill-duration',
    label: 'Restore finished inside the RTO budget',
    status: durationStatus,
    detail: durationDetail,
  });

  const hasEvidenceRef =
    typeof evidence.lastRestoreDrillEvidenceRef === 'string' &&
    evidence.lastRestoreDrillEvidenceRef.trim().length > 0;
  checks.push({
    id: 'restore-drill-evidence',
    label: 'Drill produced a referenceable artefact',
    status: hasEvidenceRef ? 'pass' : 'missing',
    detail: hasEvidenceRef
      ? `Evidence: ${evidence.lastRestoreDrillEvidenceRef}`
      : 'Drill evidence reference is empty — nothing to audit.',
  });

  checks.push({
    id: 'incident-runbook',
    label: 'Last incident runbook completed',
    status: evidence.lastIncidentRunbookCompleted ? 'pass' : 'fail',
    detail: evidence.lastIncidentRunbookCompleted
      ? 'Runbook for the most recent incident was completed.'
      : 'Runbook for the most recent incident is still open.',
  });

  return {
    kind: 'incident-recovery',
    ok: allPassed(checks),
    checkedAt: now(),
    checks,
  };
}
