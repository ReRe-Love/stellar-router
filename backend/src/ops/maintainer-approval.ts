/**
 * Approval step that consumes an explainable risk score (issue #496).
 *
 * The score is fed straight into the decision: critical scores, sanctioned
 * counterparties and key rotations demand a maintainer, high scores from a
 * plain operator are escalated to pending_review, everything else auto-approves.
 */

import type { HighImpactAction, RiskActor, RiskScore } from './risk-scoring';

export const CRITICAL_SCORE_THRESHOLD = 75;
export const HIGH_SCORE_THRESHOLD = 50;

const OPERATOR_ROLES: readonly string[] = ['operator', 'maintainer', 'admin'];
const MAINTAINER_ROLES: readonly string[] = ['maintainer', 'admin'];

export type ApprovalDecision = 'approved' | 'pending_review' | 'rejected';

export type ApprovalErrorCode = 'UNAUTHORIZED_APPROVER' | 'MISSING_JUSTIFICATION' | 'INVALID_SCORE';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    Object.setPrototypeOf(this, ApprovalError.prototype);
  }
}

export interface ApprovalRequest {
  score: RiskScore;
  approver: RiskActor;
  action?: HighImpactAction;
  justification?: string;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  requiresMaintainer: boolean;
  approverId: string;
  score: number;
  level: RiskScore['level'];
  reasons: string[];
}

function hasAnyRole(actor: RiskActor | undefined, roles: readonly string[]): boolean {
  return Array.isArray(actor?.roles) && actor.roles.some((r) => roles.includes(r));
}

function isSanctioned(score: RiskScore): boolean {
  return score.factors.some((f) => f.id === 'counterparty' && f.severity >= 1);
}

/** True when the request can only be settled by a maintainer/admin. */
export function requiresMaintainerReview(req: ApprovalRequest): boolean {
  return (
    req.score.score >= CRITICAL_SCORE_THRESHOLD || isSanctioned(req.score) || req.action === 'key.rotate'
  );
}

function validateScore(score: RiskScore): void {
  if (!score || typeof score !== 'object') {
    throw new ApprovalError('INVALID_SCORE', 'An evaluated RiskScore is required.');
  }
  if (!Number.isInteger(score.score) || score.score < 0 || score.score > 100) {
    throw new ApprovalError(
      'INVALID_SCORE',
      `score must be an integer in [0, 100]; got ${String(score.score)}.`,
    );
  }
  if (!Array.isArray(score.factors) || score.factors.length === 0) {
    throw new ApprovalError('INVALID_SCORE', 'score.factors must be a non-empty array.');
  }
  if (typeof score.reason !== 'string' || score.reason.trim() === '') {
    throw new ApprovalError('INVALID_SCORE', 'score.reason must be a non-empty string.');
  }
}

/**
 * Feed an explainable score into the approval decision.
 *
 * Authorization path  -> throws UNAUTHORIZED_APPROVER when the approver holds no
 *                        operator role, or no maintainer role for critical /
 *                        sanctioned / key-rotation requests.
 * Failure path        -> throws INVALID_SCORE for malformed scores and
 *                        MISSING_JUSTIFICATION for an unannotated critical score.
 * Normal path         -> returns an ApprovalOutcome carrying the factor reason.
 */
export function approve(req: ApprovalRequest): ApprovalOutcome {
  if (!req || !req.score) {
    throw new ApprovalError('INVALID_SCORE', 'An evaluated RiskScore is required.');
  }
  validateScore(req.score);

  const { score, approver } = req;

  if (!hasAnyRole(approver, OPERATOR_ROLES)) {
    throw new ApprovalError(
      'UNAUTHORIZED_APPROVER',
      'Approver must hold operator, maintainer or admin to approve high-impact actions.',
    );
  }

  const needsMaintainer = requiresMaintainerReview(req);
  if (needsMaintainer && !hasAnyRole(approver, MAINTAINER_ROLES)) {
    throw new ApprovalError(
      'UNAUTHORIZED_APPROVER',
      'Critical, sanctioned or key-rotation actions require a maintainer or admin approver.',
    );
  }

  const reasons: string[] = [score.reason];

  if (isSanctioned(score)) {
    reasons.push('Sanctioned counterparty: approval is blocked regardless of approver seniority.');
    return {
      decision: 'rejected',
      requiresMaintainer: needsMaintainer,
      approverId: approver.id,
      score: score.score,
      level: score.level,
      reasons,
    };
  }

  if (score.score >= CRITICAL_SCORE_THRESHOLD && !req.justification?.trim()) {
    throw new ApprovalError(
      'MISSING_JUSTIFICATION',
      `A written justification is required to approve a critical score (${score.score} >= ${CRITICAL_SCORE_THRESHOLD}).`,
    );
  }
  if (score.score >= CRITICAL_SCORE_THRESHOLD) {
    reasons.push(`Critical score approved by maintainer "${approver.id}" with justification.`);
  }

  if (score.score >= HIGH_SCORE_THRESHOLD) {
    const decision: ApprovalDecision = hasAnyRole(approver, MAINTAINER_ROLES) ? 'approved' : 'pending_review';
    if (decision === 'pending_review') {
      reasons.push(`Score ${score.score} needs maintainer sign-off; recorded as pending_review.`);
    } else if (score.score < CRITICAL_SCORE_THRESHOLD) {
      reasons.push(`High score reviewed by maintainer "${approver.id}".`);
    }
    return {
      decision,
      requiresMaintainer: needsMaintainer,
      approverId: approver.id,
      score: score.score,
      level: score.level,
      reasons,
    };
  }

  reasons.push(`Score ${score.score} is below the review threshold (${HIGH_SCORE_THRESHOLD}).`);
  return {
    decision: 'approved',
    requiresMaintainer: needsMaintainer,
    approverId: approver.id,
    score: score.score,
    level: score.level,
    reasons,
  };
}
