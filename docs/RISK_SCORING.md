# Explainable risk scoring for high-impact actions

Issue: [#496](https://github.com/Parcel-Protocol/inqutum/issues/496)

Every high-impact action (`invoice.cancel`, `invoice.refund`, `payout.release`,
`settings.update`, `key.rotate`) is scored 0–100 together with the **factor
breakdown that produced the number**, so a reviewer sees *why* an action was
flagged instead of an opaque score.

| Piece | Path |
| --- | --- |
| Scoring (pure) | `backend/src/ops/risk-scoring.ts` |
| Approval step | `backend/src/ops/maintainer-approval.ts` |
| HTTP routes | `backend/src/routes/risk.routes.ts` (`POST /api/risk/score`, `POST /api/risk/approve`) |
| Tests | `backend/tests/risk-scoring.test.ts` |

## Factors

| Factor | Weight | Threshold | Breach rule |
| --- | --- | --- | --- |
| Authorization strength | 0.30 | role strength table (`admin` 0.05 … `viewer` 0.8) | actor holds no recognised privileged role (severity 1) |
| Volume against action limit | 0.30 | per-action cap (e.g. `payout.release` 10 000) | `amount >= cap`; severity is `amount / cap` capped at 1 |
| Counterparty trust | 0.25 | `trusted` 0 · `known` 0.25 · `unverified` 0.6 · `sanctioned` 1 | `unverified` or `sanctioned` |
| Action burst velocity | 0.15 | 5 actions / window (saturates at 10) | more than 5 recent high-impact actions |

`score = min(100, Σ round(severity × weight × 100))` — the factor
contributions therefore **sum exactly to the score** (asserted by the tests).
Bands: `<25 low`, `<50 medium`, `<75 high`, `≥75 critical`.

`reason` lists every breached factor with its observed vs threshold values,
ordered by contribution.

## Paths covered

- **Normal** — full `RiskScore` with four factors, stable `inputHash`, `reason`.
- **Failure** — `scoreRisk` throws `RiskScoringError` (`INVALID_INPUT` /
  `UNSUPPORTED_ACTION`) and never returns a partial score; `approve` throws
  `INVALID_SCORE` / `MISSING_JUSTIFICATION`. Routes map these to HTTP 400.
- **Retry** — scoring is pure and deterministic: identical input → identical
  `score`, `factors`, `reason` and `inputHash` (key-sorted canonical JSON +
  FNV-1a). Pass `requestedAt` to make even `computedAt` byte-identical.
  Tests assert `deepEqual` across retries and that reordered properties hash
  the same.
- **Authorization** — `authorizeRiskScorer(caller)` fails closed unless the
  caller holds `risk.scorer`, `maintainer` or `admin` (HTTP 403). The approval
  step independently requires an `operator` role, and `maintainer`/`admin` for
  critical, sanctioned or `key.rotate` requests (`UNAUTHORIZED_APPROVER`,
  HTTP 403). No authenticated actor at all → 401.

## Approval rules

| Condition | Result |
| --- | --- |
| counterparty `sanctioned` | `rejected` (hard block, even for a maintainer) |
| score ≥ 75 or `key.rotate` | maintainer required + non-empty `justification`, else `MISSING_JUSTIFICATION` |
| 50 ≤ score < 75, approver is maintainer | `approved` |
| 50 ≤ score < 75, approver is operator | `pending_review` (escalated) |
| score < 50 | `approved` |

## Edge cases

- **Non amount-bearing actions** (`settings.update`, `key.rotate`) have cap `0`;
  the volume factor reports severity 0 and "not amount-bearing" instead of
  dividing by zero.
- **Amount exactly at the cap** counts as a breach (`>=`) with severity 1.
- **Amount far above the cap** — severity stays capped at 1, score stays ≤ 100.
- **Actor with no recognised role** — authorization severity 1 (breached).
- **Unknown counterparty trust level, NaN/negative amount, fractional
  `recentActionCount`, bad `requestedAt`** — rejected with `INVALID_INPUT`
  before any factor is computed.
- **Score supplied to `/approve` out of range or with empty factors** —
  rejected with `INVALID_SCORE`.
- **`requestedAt` omitted** — `computedAt` falls back to "now"; retries remain
  comparable via `inputHash`.

## Recovery / rollback

- Scoring is **stateless**: no writes, so a failed evaluation needs no
  rollback — simply retry; determinism guarantees the same answer.
- Approval outcomes are plain values; a wrongly escalated decision is corrected
  by re-running `approve` with the same score (it is a pure function), or by a
  maintainer settling a `pending_review`.
- If the factor table ever needs reverting, bump `RiskScore.version` and keep
  the previous table behind it — existing stored scores keep their original
  `version` field for audit.

## Migration plan

Additive only — no existing endpoint, contract or storage schema changes:

1. `risk-scoring.ts`, `maintainer-approval.ts`, `risk.routes.ts` are new files.
2. Mount `riskRouter` wherever the other API routers are registered
   (`app.use('/api/risk', riskRouter)`); existing routes are untouched.
3. The Postgres/MVP servers should populate `req.actor` from the session; the
   `body.caller` fallback exists only for the dependency-free MVP path and must
   not be relied on in production.

## Running the tests

```
cd backend
node --import tsx --test tests/risk-scoring.test.ts
```
