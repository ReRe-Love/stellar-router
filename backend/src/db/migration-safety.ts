/**
 * Migration safety evidence for the release gate (issue #497).
 *
 * Produces the pre-release migration report the gate consumes. Pure with
 * respect to its `deps` — the caller supplies how to read migration state, so
 * the same code runs against a live database, fixtures or a test double.
 */

export type CheckStatus = 'pass' | 'fail' | 'missing';

export interface GateCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface MigrationSafetyReport {
  kind: 'migration-safety';
  /** True only when every check `pass`es. A single `missing`/`fail` makes it false. */
  ok: boolean;
  checkedAt: string;
  checks: GateCheck[];
}

export interface MigrationEvidence {
  /** Files still to apply, e.g. ["0042_add_invoice_index.sql"]. */
  pendingMigrations: string[];
  /** Every pending migration id mapped to whether a rollback script exists for it. */
  rollbackScriptExists: Record<string, boolean>;
  /** Schema checksum the release expects (from the migration artefact). */
  expectedSchemaChecksum: string;
  /** Schema checksum the target database actually reports. */
  actualSchemaChecksum: string;
}

export interface MigrationSafetyDeps {
  loadEvidence(): Promise<MigrationEvidence>;
}

function allPassed(checks: GateCheck[]): boolean {
  return checks.every((c) => c.status === 'pass');
}

/**
 * Evaluate migration evidence for a release.
 *
 * Checks (in order):
 *  1. `schema-checksum`   — expected and actual checksum must match.
 *  2. `pending-rollback`  — every pending migration must have a rollback script.
 *  3. `pending-list`      — informational: which migrations are still pending.
 *
 * Failure path: throws `MigrationSafetyError('EVIDENCE_UNAVAILABLE')` when
 * `loadEvidence` rejects or returns unusable data — the gate treats a thrown
 * evaluation as a failing result, never as a pass.
 */
export async function checkMigrationSafety(
  deps: MigrationSafetyDeps,
  now: () => string = () => new Date().toISOString(),
): Promise<MigrationSafetyReport> {
  let evidence: MigrationEvidence;
  try {
    evidence = await deps.loadEvidence();
  } catch (err) {
    throw new MigrationSafetyError(
      'EVIDENCE_UNAVAILABLE',
      `Migration evidence could not be loaded: ${(err as Error).message}`,
    );
  }

  if (
    !evidence ||
    typeof evidence.expectedSchemaChecksum !== 'string' ||
    typeof evidence.actualSchemaChecksum !== 'string' ||
    !Array.isArray(evidence.pendingMigrations) ||
    typeof evidence.rollbackScriptExists !== 'object'
  ) {
    throw new MigrationSafetyError(
      'EVIDENCE_MALFORMED',
      'Migration evidence is missing required fields (checksums, pending list, rollback map).',
    );
  }

  const checks: GateCheck[] = [];

  const checksumMatches =
    evidence.expectedSchemaChecksum.length > 0 &&
    evidence.expectedSchemaChecksum === evidence.actualSchemaChecksum;
  checks.push({
    id: 'schema-checksum',
    label: 'Schema checksum matches migration artefact',
    status: checksumMatches ? 'pass' : 'fail',
    detail: checksumMatches
      ? `Checksum ${evidence.expectedSchemaChecksum} matches the target database.`
      : `Expected ${evidence.expectedSchemaChecksum || '(empty)'}, database reports ${
          evidence.actualSchemaChecksum || '(empty)'
        }.`,
  });

  const missingRollback = evidence.pendingMigrations.filter(
    (m) => evidence.rollbackScriptExists[m] !== true,
  );
  checks.push({
    id: 'pending-rollback',
    label: 'Every pending migration has a rollback script',
    status: missingRollback.length === 0 ? 'pass' : 'fail',
    detail:
      missingRollback.length === 0
        ? `${evidence.pendingMigrations.length} pending migration(s) all have rollback scripts.`
        : `No rollback script for: ${missingRollback.join(', ')}.`,
  });

  checks.push({
    id: 'pending-list',
    label: 'Pending migrations enumerated',
    status: 'pass',
    detail:
      evidence.pendingMigrations.length === 0
        ? 'No pending migrations.'
        : `Pending: ${evidence.pendingMigrations.join(', ')}.`,
  });

  return {
    kind: 'migration-safety',
    ok: allPassed(checks),
    checkedAt: now(),
    checks,
  };
}

export type MigrationSafetyErrorCode = 'EVIDENCE_UNAVAILABLE' | 'EVIDENCE_MALFORMED';

export class MigrationSafetyError extends Error {
  readonly code: MigrationSafetyErrorCode;

  constructor(code: MigrationSafetyErrorCode, message: string) {
    super(message);
    this.name = 'MigrationSafetyError';
    this.code = code;
    Object.setPrototypeOf(this, MigrationSafetyError.prototype);
  }
}
