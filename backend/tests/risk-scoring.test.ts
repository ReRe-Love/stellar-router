/**
 * Tests for explainable risk scoring (issue #496).
 *
 * Covers the four required paths:
 *   normal        -> happy-path score with a full factor breakdown
 *   failure       -> invalid inputs throw, no partial score is returned
 *   retry         -> identical input yields an identical score and inputHash
 *   authorization -> unauthorized scorers and approvers are rejected
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeRiskScorer,
  scoreRisk,
  RiskScoringError,
} from '../src/ops/risk-scoring';
import type { RiskEvaluationInput, RiskScore } from '../src/ops/risk-scoring';
import { approve, ApprovalError, requiresMaintainerReview } from '../src/ops/maintainer-approval';

const REQUESTED_AT = '2026-11-22T00:00:00.000Z';

function baseInput(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    action: 'payout.release',
    actor: { id: 'G-OPERATOR', roles: ['operator'] },
    amount: 250,
    asset: 'USDC',
    counterparty: { id: 'G-CLIENT', trust: 'known' },
    recentActionCount: 1,
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

describe('scoreRisk — normal path', () => {
  it('returns a low score whose factors sum exactly to the score', () => {
    const score = scoreRisk(
      baseInput({
        actor: { id: 'G-ADMIN', roles: ['admin'] },
        amount: 100,
        counterparty: { id: 'G-CLIENT', trust: 'trusted' },
        recentActionCount: 0,
      }),
    );

    assert.equal(score.version, '1');
    assert.equal(score.level, 'low');
    assert.ok(score.score < 25, `expected low band, got ${score.score}`);
    assert.equal(score.factors.length, 4);

    const sum = score.factors.reduce((total, f) => total + f.contribution, 0);
    assert.equal(sum, score.score, 'factor contributions must sum to the score');

    assert.equal(score.computedAt, REQUESTED_AT);
    assert.match(score.inputHash, /^[0-9a-f]{8}$/);
    assert.equal(score.reason, 'No factor crossed its threshold.');
  });

  it('exposes weights, thresholds and observed values on every factor', () => {
    const score = scoreRisk(baseInput({ amount: 5_000 }));
    const volume = score.factors.find((f) => f.id === 'volume');
    assert.ok(volume);
    assert.equal(volume.weight, 0.3);
    assert.equal(volume.threshold, 10_000);
    assert.equal(volume.observed, 5_000);
    assert.ok(volume.detail.includes('5000 USDC of a 10000 USDC cap'));
  });

  it('flags a breached threshold in the human readable reason', () => {
    const score = scoreRisk(
      baseInput({
        actor: { id: 'G-VIEWER', roles: ['viewer'] },
        amount: 10_000,
        counterparty: { id: 'G-STRANGER', trust: 'unverified' },
        recentActionCount: 12,
      }),
    );

    assert.equal(score.level, 'critical');
    assert.ok(score.score >= 75, `expected critical band, got ${score.score}`);

    const volume = score.factors.find((f) => f.id === 'volume');
    assert.ok(volume?.breached);
    assert.equal(volume?.observed, 10_000);
    assert.equal(volume?.threshold, 10_000);

    assert.ok(score.reason.includes('Volume against action limit'));
    assert.ok(score.reason.includes('at or above the 10000 USDC cap'));
    assert.ok(score.reason.includes('Burst'));
  });

  it('caps severity when the amount is above the limit', () => {
    const score = scoreRisk(baseInput({ amount: 50_000 }));
    const volume = score.factors.find((f) => f.id === 'volume');
    assert.equal(volume?.severity, 1, 'severity must be capped at 1');
    assert.ok(score.score <= 100);
  });

  it('treats non amount-bearing actions as zero volume risk', () => {
    const score = scoreRisk(baseInput({ action: 'key.rotate', amount: 0 }));
    const volume = score.factors.find((f) => f.id === 'volume');
    assert.equal(volume?.severity, 0);
    assert.equal(volume?.breached, false);
    assert.ok(volume?.detail.includes('not amount-bearing'));
  });
});

describe('scoreRisk — failure path', () => {
  it('rejects a negative amount', () => {
    assert.throws(
      () => scoreRisk(baseInput({ amount: -1 })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'INVALID_INPUT',
    );
  });

  it('rejects a non-finite amount', () => {
    assert.throws(
      () => scoreRisk(baseInput({ amount: Number.NaN })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'INVALID_INPUT',
    );
  });

  it('rejects an unsupported action', () => {
    assert.throws(
      () => scoreRisk(baseInput({ action: 'transfer.everything' as never })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'UNSUPPORTED_ACTION',
    );
  });

  it('rejects a fractional recentActionCount', () => {
    assert.throws(
      () => scoreRisk(baseInput({ recentActionCount: 1.5 })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'INVALID_INPUT',
    );
  });

  it('rejects an unknown counterparty trust level', () => {
    assert.throws(
      () => scoreRisk(baseInput({ counterparty: { id: 'G-X', trust: 'shady' as never } })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'INVALID_INPUT',
    );
  });

  it('rejects an unparseable requestedAt', () => {
    assert.throws(
      () => scoreRisk(baseInput({ requestedAt: 'yesterday' })),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'INVALID_INPUT',
    );
  });
});

describe('scoreRisk — retry path', () => {
  it('produces an identical result on every retry', () => {
    const first = scoreRisk(baseInput({ amount: 4_000 }));
    const second = scoreRisk(baseInput({ amount: 4_000 }));
    assert.deepEqual(second, first);
    assert.equal(second.inputHash, first.inputHash);
  });

  it('keeps inputHash stable across property order', () => {
    const reordered = {
      requestedAt: REQUESTED_AT,
      recentActionCount: 1,
      counterparty: { trust: 'known' as const, id: 'G-CLIENT' },
      asset: 'USDC',
      amount: 250,
      actor: { roles: ['operator'], id: 'G-OPERATOR' },
      action: 'payout.release' as const,
    };
    assert.equal(scoreRisk(reordered).inputHash, scoreRisk(baseInput()).inputHash);
  });

  it('changes inputHash when the input changes', () => {
    const a = scoreRisk(baseInput({ amount: 250 }));
    const b = scoreRisk(baseInput({ amount: 251 }));
    assert.notEqual(a.inputHash, b.inputHash);
  });

  it('reports requestedAt as computedAt so retries stay byte-identical', () => {
    const score: RiskScore = scoreRisk(baseInput());
    assert.equal(score.computedAt, REQUESTED_AT);
  });
});

describe('authorization path', () => {
  it('rejects a caller with no scorer role', () => {
    assert.throws(
      () => authorizeRiskScorer({ id: 'G-NOBODY', roles: [] }),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'UNAUTHORIZED',
    );
  });

  it('rejects a caller with only a viewer role', () => {
    assert.throws(
      () => authorizeRiskScorer({ id: 'G-VIEWER', roles: ['viewer'] }),
      (err: unknown) => err instanceof RiskScoringError && err.code === 'UNAUTHORIZED',
    );
  });

  it('accepts risk.scorer, maintainer and admin callers', () => {
    assert.doesNotThrow(() => authorizeRiskScorer({ id: 'G-1', roles: ['risk.scorer'] }));
    assert.doesNotThrow(() => authorizeRiskScorer({ id: 'G-2', roles: ['maintainer'] }));
    assert.doesNotThrow(() => authorizeRiskScorer({ id: 'G-3', roles: ['admin'] }));
  });
});

describe('maintainer approval — feeding the score into the decision', () => {
  const lowScore = () => scoreRisk(baseInput());

  const highScore = () =>
    scoreRisk(
      baseInput({
        actor: { id: 'G-VIEWER', roles: ['viewer'] },
        amount: 5_000,
        counterparty: { id: 'G-STRANGER', trust: 'unverified' },
        recentActionCount: 6,
      }),
    );

  const criticalScore = () =>
    scoreRisk(
      baseInput({
        actor: { id: 'G-VIEWER', roles: ['viewer'] },
        amount: 12_000,
        counterparty: { id: 'G-STRANGER', trust: 'unverified' },
        recentActionCount: 12,
      }),
    );

  const operator = { id: 'G-OPERATOR', roles: ['operator'] };
  const maintainer = { id: 'G-MAINTAINER', roles: ['maintainer'] };

  it('auto-approves a low score for an operator', () => {
    const outcome = approve({ score: lowScore(), approver: operator });
    assert.equal(outcome.decision, 'approved');
    assert.equal(outcome.requiresMaintainer, false);
    assert.ok(outcome.reasons.length > 0);
  });

  it('escalates a high score from an operator to pending_review', () => {
    const score = highScore();
    assert.equal(score.level, 'high');
    const outcome = approve({ score, approver: operator });
    assert.equal(outcome.decision, 'pending_review');
    assert.ok(outcome.reasons.some((r) => r.includes('maintainer sign-off')));
  });

  it('lets a maintainer settle the same high score', () => {
    const outcome = approve({ score: highScore(), approver: maintainer });
    assert.equal(outcome.decision, 'approved');
  });

  it('refuses a critical score for a non-maintainer (authorization path)', () => {
    assert.throws(
      () => approve({ score: criticalScore(), approver: operator, justification: 'ok' }),
      (err: unknown) => err instanceof ApprovalError && err.code === 'UNAUTHORIZED_APPROVER',
    );
  });

  it('requires a justification for a critical score (failure path)', () => {
    assert.throws(
      () => approve({ score: criticalScore(), approver: maintainer }),
      (err: unknown) => err instanceof ApprovalError && err.code === 'MISSING_JUSTIFICATION',
    );
  });

  it('approves a critical score when a maintainer supplies a justification', () => {
    const outcome = approve({
      score: criticalScore(),
      approver: maintainer,
      justification: 'Client is a long-standing partner; amount verified twice.',
    });
    assert.equal(outcome.decision, 'approved');
    assert.equal(outcome.requiresMaintainer, true);
  });

  it('always rejects a sanctioned counterparty, even for a maintainer', () => {
    const score = scoreRisk(baseInput({ counterparty: { id: 'G-BAD', trust: 'sanctioned' } }));
    const outcome = approve({ score, approver: maintainer });
    assert.equal(outcome.decision, 'rejected');
    assert.ok(outcome.reasons.some((r) => r.includes('Sanctioned counterparty')));
  });

  it('requires a maintainer for key rotations regardless of score', () => {
    const score = scoreRisk(baseInput({ action: 'key.rotate', amount: 0 }));
    assert.ok(requiresMaintainerReview({ score, approver: operator, action: 'key.rotate' }));
    assert.throws(
      () => approve({ score, approver: operator, action: 'key.rotate' }),
      (err: unknown) => err instanceof ApprovalError && err.code === 'UNAUTHORIZED_APPROVER',
    );
  });

  it('rejects a malformed score (failure path)', () => {
    const broken = { ...lowScore(), score: 150 } as RiskScore;
    assert.throws(
      () => approve({ score: broken, approver: operator }),
      (err: unknown) => err instanceof ApprovalError && err.code === 'INVALID_SCORE',
    );
  });

  it('rejects an approver with no operator role (authorization path)', () => {
    assert.throws(
      () => approve({ score: lowScore(), approver: { id: 'G-READER', roles: ['viewer'] } }),
      (err: unknown) => err instanceof ApprovalError && err.code === 'UNAUTHORIZED_APPROVER',
    );
  });
});
