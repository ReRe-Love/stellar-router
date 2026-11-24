/**
 * Tests for the release readiness gate (issue #497).
 *
 * Covers the four required paths:
 *   normal        -> both evidence sets pass, gate reports ready
 *   failure       -> failing / malformed / throwing evidence blocks the release
 *   retry         -> fixed evidence produces an identical report every run
 *   authorization -> an actor without a gate role is refused before any check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runReleaseGate, ReleaseGateError, RELEASE_GATE_ROLES } from '../src/ops/release-gate';
import type { ReleaseGateDeps, ReleaseGateReport } from '../src/ops/release-gate';
import { checkMigrationSafety, MigrationSafetyError } from '../src/db/migration-safety';
import type { MigrationEvidence } from '../src/db/migration-safety';
import { checkIncidentRecovery, RecoveryCheckError } from '../src/ops/incident-recovery-checks';
import type { RecoveryEvidence } from '../src/ops/incident-recovery-checks';

const NOW = '2026-11-22T12:00:00.000Z';
const clock = () => NOW;

const RELEASE_MANAGER = { id: 'G-RELEASE', roles: ['release.manager'] };
const OUTSIDER = { id: 'G-CURIOUS', roles: ['viewer'] };

/** Evidence where everything passes. */
function goodMigration(): MigrationEvidence {
  return {
    pendingMigrations: ['0042_add_invoice_index.sql'],
    rollbackScriptExists: { '0042_add_invoice_index.sql': true },
    expectedSchemaChecksum: 'sha256:abc123',
    actualSchemaChecksum: 'sha256:abc123',
  };
}

function goodRecovery(): RecoveryEvidence {
  return {
    lastRestoreDrillAt: '2026-11-15T09:00:00.000Z',
    lastIncidentRunbookCompleted: true,
    lastRestoreDrillDurationSeconds: 420,
    lastRestoreDrillEvidenceRef: 'evidence/restore-drill-2026-11-15.md',
  };
}

function goodDeps(): ReleaseGateDeps {
  return {
    migrationDeps: { loadEvidence: async () => goodMigration() },
    recoveryDeps: { loadEvidence: async () => goodRecovery() },
  };
}

async function gate(deps: ReleaseGateDeps = goodDeps(), actor = RELEASE_MANAGER): Promise<ReleaseGateReport> {
  return runReleaseGate({ releaseId: 'rel-2026-11-22', actor, deps, now: clock });
}

describe('release gate — normal path', () => {
  it('reports ready when migration and recovery evidence both pass', async () => {
    const report = await gate();
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.results.length, 2);
    assert.deepEqual(
      report.results.map((r) => r.name),
      ['migration-safety', 'incident-recovery'],
    );
    assert.ok(report.results.every((r) => r.status === 'pass'));
    assert.equal(report.actor?.authorized, true);
    assert.equal(report.checkedAt, NOW);
  });

  it('carries the underlying check breakdown for audit', async () => {
    const report = await gate();
    const migration = report.results.find((r) => r.name === 'migration-safety');
    assert.ok(migration);
    assert.ok(migration.checks.some((c) => c.id === 'schema-checksum' && c.status === 'pass'));
    const recovery = report.results.find((r) => r.name === 'incident-recovery');
    assert.ok(recovery);
    assert.ok(recovery.checks.some((c) => c.id === 'restore-drill-freshness' && c.status === 'pass'));
  });

  it('accepts every documented gate role', async () => {
    for (const role of RELEASE_GATE_ROLES) {
      const report = await gate(goodDeps(), { id: 'G-ANY', roles: [role] });
      assert.equal(report.ready, true, `role ${role} must be authorized`);
    }
  });
});

describe('release gate — failure path', () => {
  it('blocks on a schema checksum mismatch', async () => {
    const report = await gate({
      migrationDeps: { loadEvidence: async () => ({ ...goodMigration(), actualSchemaChecksum: 'sha256:other' }) },
      recoveryDeps: { loadEvidence: async () => goodRecovery() },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('schema-checksum')));
    const migration = report.results.find((r) => r.name === 'migration-safety');
    assert.equal(migration?.status, 'fail');
    assert.equal(report.results.find((r) => r.name === 'incident-recovery')?.status, 'pass');
  });

  it('blocks when a pending migration has no rollback script', async () => {
    const report = await gate({
      migrationDeps: {
        loadEvidence: async () => ({
          ...goodMigration(),
          rollbackScriptExists: { '0042_add_invoice_index.sql': false },
        }),
      },
      recoveryDeps: { loadEvidence: async () => goodRecovery() },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('pending-rollback')));
  });

  it('blocks (fail closed) when there is no restore drill on record', async () => {
    const report = await gate({
      migrationDeps: { loadEvidence: async () => goodMigration() },
      recoveryDeps: { loadEvidence: async () => ({ ...goodRecovery(), lastRestoreDrillAt: null }) },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('restore-drill-freshness: missing')));
    assert.equal(report.results.find((r) => r.name === 'incident-recovery')?.status, 'missing');
  });

  it('blocks when the restore drill exceeded the RTO budget', async () => {
    const report = await gate({
      migrationDeps: { loadEvidence: async () => goodMigration() },
      recoveryDeps: {
        loadEvidence: async () => ({ ...goodRecovery(), lastRestoreDrillDurationSeconds: 5_000 }),
      },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('restore-drill-duration: fail')));
  });

  it('blocks when evidence loading throws — an error never counts as a pass', async () => {
    const report = await gate({
      migrationDeps: {
        loadEvidence: async () => {
          throw new Error('database unreachable');
        },
      },
      recoveryDeps: { loadEvidence: async () => goodRecovery() },
    });
    assert.equal(report.ready, false);
    const migration = report.results.find((r) => r.name === 'migration-safety');
    assert.equal(migration?.status, 'error');
    assert.ok(report.blockers.some((b) => b.includes('database unreachable')));
  });

  it('blocks when migration evidence is malformed', async () => {
    const report = await gate({
      migrationDeps: {
        loadEvidence: async () => ({ pendingMigrations: 'nope' } as unknown as MigrationEvidence),
      },
      recoveryDeps: { loadEvidence: async () => goodRecovery() },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('migration-safety: error')));
  });

  it('blocks when recovery evidence is malformed', async () => {
    const report = await gate({
      migrationDeps: { loadEvidence: async () => goodMigration() },
      recoveryDeps: {
        loadEvidence: async () => ({ lastIncidentRunbookCompleted: 'yes' } as unknown as RecoveryEvidence),
      },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('incident-recovery: error')));
  });

  it('blocks when the incident runbook is still open', async () => {
    const report = await gate({
      migrationDeps: { loadEvidence: async () => goodMigration() },
      recoveryDeps: { loadEvidence: async () => ({ ...goodRecovery(), lastIncidentRunbookCompleted: false }) },
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((b) => b.includes('incident-runbook')));
  });

  it('requires a releaseId', async () => {
    await assert.rejects(
      runReleaseGate({ releaseId: '', actor: RELEASE_MANAGER, deps: goodDeps(), now: clock }),
      (err: unknown) => err instanceof ReleaseGateError && err.code === 'GATE_FAILED',
    );
  });
});

describe('release gate — retry path', () => {
  it('produces an identical report on every retry with fixed evidence', async () => {
    const first = await gate();
    const second = await gate();
    assert.deepEqual(second, first);
  });

  it('produces an identical blocker list on repeated failing runs', async () => {
    const failing = () =>
      gate({
        migrationDeps: {
          loadEvidence: async () => ({ ...goodMigration(), expectedSchemaChecksum: 'sha256:stale' }),
        },
        recoveryDeps: { loadEvidence: async () => goodRecovery() },
      });
    const first = await failing();
    const second = await failing();
    assert.equal(first.ready, false);
    assert.deepEqual(second.blockers, first.blockers);
    assert.deepEqual(second.results, first.results);
  });

  it('supports evaluating the underlying checks standalone and reproducibly', async () => {
    const deps = { loadEvidence: async () => goodMigration() };
    const first = await checkMigrationSafety(deps, clock);
    const second = await checkMigrationSafety(deps, clock);
    assert.deepEqual(second, first);
    assert.equal(first.ok, true);

    const recoveryDeps = { loadEvidence: async () => goodRecovery() };
    const r1 = await checkIncidentRecovery(recoveryDeps, clock);
    const r2 = await checkIncidentRecovery(recoveryDeps, clock);
    assert.deepEqual(r2, r1);
    assert.equal(r1.ok, true);
  });
});

describe('release gate — authorization path', () => {
  it('refuses an actor without a gate role before running any check', async () => {
    let migrationLoaded = false;
    await assert.rejects(
      runReleaseGate({
        releaseId: 'rel-2026-11-22',
        actor: OUTSIDER,
        deps: {
          migrationDeps: {
            loadEvidence: async () => {
              migrationLoaded = true;
              return goodMigration();
            },
          },
        },
        now: clock,
      }),
      (err: unknown) => err instanceof ReleaseGateError && err.code === 'UNAUTHORIZED',
    );
    assert.equal(migrationLoaded, false, 'evidence must not be touched after an auth failure');
  });

  it('refuses an actor with empty roles', async () => {
    await assert.rejects(
      runReleaseGate({ releaseId: 'rel-1', actor: { id: 'G-NOBODY', roles: [] }, deps: goodDeps(), now: clock }),
      (err: unknown) => err instanceof ReleaseGateError && err.code === 'UNAUTHORIZED',
    );
  });

  it('names the offending actor and the required roles in the message', async () => {
    await assert.rejects(
      runReleaseGate({ releaseId: 'rel-1', actor: OUTSIDER, deps: goodDeps(), now: clock }),
      (err: unknown) =>
        err instanceof ReleaseGateError &&
        err.message.includes('G-CURIOUS') &&
        err.message.includes('release.manager'),
    );
  });

  it('does not treat unrelated roles as authorized', async () => {
    for (const role of ['operator', 'maintainer', 'risk.scorer', 'super.admin']) {
      await assert.rejects(
        runReleaseGate({ releaseId: 'rel-1', actor: { id: 'G-X', roles: [role] }, deps: goodDeps(), now: clock }),
        (err: unknown) => err instanceof ReleaseGateError && err.code === 'UNAUTHORIZED',
        `role ${role} must not pass the gate`,
      );
    }
  });
});

describe('evidence checkers — standalone failure behaviour', () => {
  it('checkMigrationSafety throws EVIDENCE_UNAVAILABLE when loading fails', async () => {
    await assert.rejects(
      checkMigrationSafety({
        loadEvidence: async () => {
          throw new Error('timeout');
        },
      }, clock),
      (err: unknown) => err instanceof MigrationSafetyError && err.code === 'EVIDENCE_UNAVAILABLE',
    );
  });

  it('checkMigrationSafety reports ok=false for a rollback gap without throwing', async () => {
    const report = await checkMigrationSafety(
      {
        loadEvidence: async () => ({
          pendingMigrations: ['a.sql', 'b.sql'],
          rollbackScriptExists: { 'a.sql': true },
          expectedSchemaChecksum: 'x',
          actualSchemaChecksum: 'x',
        }),
      },
      clock,
    );
    assert.equal(report.ok, false);
    assert.ok(report.checks.find((c) => c.id === 'pending-rollback')?.detail.includes('b.sql'));
  });

  it('checkIncidentRecovery throws EVIDENCE_MALFORMED on bad shapes', async () => {
    await assert.rejects(
      checkIncidentRecovery({ loadEvidence: async () => ({}) as RecoveryEvidence }, clock),
      (err: unknown) => err instanceof RecoveryCheckError && err.code === 'EVIDENCE_MALFORMED',
    );
  });

  it('checkIncidentRecovery flags a stale drill as fail', async () => {
    const report = await checkIncidentRecovery(
      { loadEvidence: async () => ({ ...goodRecovery(), lastRestoreDrillAt: '2026-01-01T00:00:00.000Z' }) },
      clock,
    );
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.id === 'restore-drill-freshness')?.status, 'fail');
  });

  it('checkIncidentRecovery flags empty drill evidence as missing', async () => {
    const report = await checkIncidentRecovery(
      { loadEvidence: async () => ({ ...goodRecovery(), lastRestoreDrillEvidenceRef: '  ' }) },
      clock,
    );
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.id === 'restore-drill-evidence')?.status, 'missing');
  });
});
