# Release readiness gate — migrations & recovery evidence

Issue: [#497](https://github.com/Parcel-Protocol/inqutum/issues/497)

A release may not ship until there is **positive evidence** that migrations are
safe *and* that the recovery path still works. Both checks live in the release
gate; a missing result (the check never ran, threw, or produced unusable data)
is treated exactly like a failing result — the gate **fails closed**.

| Piece | Path |
| --- | --- |
| The gate | `backend/src/ops/release-gate.ts` (`runReleaseGate`) |
| Migration evidence | `backend/src/db/migration-safety.ts` (`checkMigrationSafety`) |
| Recovery evidence | `backend/src/ops/incident-recovery-checks.ts` (`checkIncidentRecovery`) |
| Tests | `backend/tests/release-readiness-gate.test.ts` |

## Usage

```ts
import { runReleaseGate, ReleaseGateError } from './ops/release-gate';

try {
  const report = await runReleaseGate({
    releaseId: 'rel-2026-11-23',
    actor: { id: 'G-1', roles: ['release.manager'] },
  });
  if (!report.ready) {
    // report.blockers lists every reason, e.g.
    // "migration-safety/schema-checksum: fail — Expected sha256:abc, database reports sha256:def."
    throw new Error(report.blockers.join('\n'));
  }
} catch (err) {
  if (err instanceof ReleaseGateError && err.code === 'UNAUTHORIZED') {
    // wrong role — no evidence was even evaluated
  }
  throw err;
}
```

Custom evidence sources are injected through `deps` (used by the tests and by
CI, which reads evidence from artefacts rather than a live database):

```ts
await runReleaseGate({
  releaseId,
  actor,
  deps: {
    migrationDeps: { loadEvidence: async () => ({ /* MigrationEvidence */ }) },
    recoveryDeps: { loadEvidence: async () => ({ /* RecoveryEvidence */ }) },
  },
});
```

## Gate 1 — migration safety (`checkMigrationSafety`)

| Check id | Passes when | Fails / missing when |
| --- | --- | --- |
| `schema-checksum` | expected checksum from the migration artefact equals the database's actual checksum | mismatch (`fail`), empty checksum (`fail`) |
| `pending-rollback` | every pending migration has a rollback script | any pending migration without one (`fail`) |
| `pending-list` | always `pass` — informational listing of pending migrations | — |

Failure modes:

- `loadEvidence` rejects → `MigrationSafetyError('EVIDENCE_UNAVAILABLE')`.
- Evidence missing required fields → `MigrationSafetyError('EVIDENCE_MALFORMED')`.
  The gate converts either into `results[i].status = 'error'` and a blocker.

## Gate 2 — incident recovery (`checkIncidentRecovery`)

| Check id | Passes when | Fails / missing when |
| --- | --- | --- |
| `restore-drill-freshness` | a restore drill exists within `maxDrillAgeDays` (default 30) | no drill on record or unparseable timestamp (`missing`), drill older than the window (`fail`) |
| `restore-drill-duration` | drill finished within `maxRestoreSeconds` (default 900) | over budget (`fail`), duration not recorded (`missing`) |
| `restore-drill-evidence` | the drill produced a non-empty evidence reference | empty/whitespace reference (`missing`) |
| `incident-runbook` | the last incident runbook was completed | runbook still open (`fail`) |

Failure modes: `RecoveryCheckError('EVIDENCE_UNAVAILABLE' | 'EVIDENCE_MALFORMED')`,
mapped by the gate to `status: 'error'` plus a blocker — never a pass.

## Authorization

`runReleaseGate` checks the actor **before touching any evidence**. Only
`release.manager` and `admin` (`RELEASE_GATE_ROLES`) may run the gate; anyone
else gets `ReleaseGateError('UNAUTHORIZED')` and no check is evaluated (the
tests assert the evidence loader is never called). Unrelated roles
(`operator`, `maintainer`, `risk.scorer`, `super.admin`) are all refused.

## Paths covered

- **Normal** — both reports pass → `ready: true`, `blockers: []`, both results
  `pass`, with the full underlying check breakdown attached for audit.
- **Failure** — checksum mismatch, missing rollback script, stale/absent drill,
  drill over RTO, open runbook, malformed evidence, or a throwing evidence
  loader each produce `ready: false` with a specific blocker string.
- **Retry** — deterministic: with a fixed clock and fixed evidence the report
  (including the blocker list) is byte-identical across runs; tests assert
  `deepEqual`. Re-running after fixing evidence simply flips `ready` to true —
  there is no state to unwind.
- **Authorization** — see above; fails closed before evidence is read.

## Edge cases

- **Check never wired up** (deps omitted) — the gate falls back to its default
  loaders; with default/empty evidence the recovery checks report
  `missing` (no drill on record) and the gate blocks. A gate that cannot prove
  recovery does not open.
- **Evidence loader throws** — recorded as `status: 'error'`, not as `missing`
  and not as a pass; the release stays blocked with the original message.
- **Empty `releaseId`** — `ReleaseGateError('GATE_FAILED')` before any work.
- **Clock injection** — every check takes `now()` so tests (and CI replay)
  control time; an unparseable `now()` makes freshness checks report `missing`
  rather than accidentally passing.
- **Both gates run even if the first fails** — blockers are accumulated, so one
  run reports everything that is wrong instead of one problem at a time.

## Recovery / rollback behavior

- The gate is **read-only**: it never mutates migration state, evidence or
  configuration, so there is nothing to roll back after a run — pass or fail.
- A blocked release is recovered by **fixing the evidence and re-running**
  (apply the missing rollback script, run a fresh restore drill, complete the
  runbook). Because runs are deterministic, the re-run's report can be diffed
  against the failing one to confirm exactly which blocker cleared.
- If a release slipped through before this gate existed, run
  `runReleaseGate` retroactively with the current evidence; a `ready: false`
  report doubles as the incident checklist.
- Throwing `ReleaseGateError` carries `.report` (when available) so callers can
  log the full evidence trail on refusal.

## Migration plan

Additive only — no existing contracts, routes or schemas change:

1. New files: `release-gate.ts`, `migration-safety.ts`,
   `incident-recovery-checks.ts`, this document, and the test file.
2. Wire `runReleaseGate` into the release script/CI step (it is a plain async
   function — no server restart or data migration required).
3. Existing deploy flow keeps working unchanged until the CI step is added;
   removing the step reverts to the previous behaviour with no leftover state.

## Running the tests

```
cd backend
node --import tsx --test tests/release-readiness-gate.test.ts
```
