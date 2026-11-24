/**
 * HTTP surface for explainable risk scoring (issue #496).
 *
 * Mount with: app.use('/api/risk', riskRouter)
 *
 * POST /api/risk/score    -> { success: true, data: RiskScore } with the full factor breakdown
 * POST /api/risk/approve  -> { success: true, data: ApprovalOutcome }
 *
 * Errors use the shared ApiResponse envelope:
 *   401 UNAUTHENTICATED, 403 UNAUTHORIZED / UNAUTHORIZED_APPROVER,
 *   400 INVALID_INPUT / UNSUPPORTED_ACTION / INVALID_SCORE / MISSING_JUSTIFICATION,
 *   500 INTERNAL_ERROR.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

import { authorizeRiskScorer, scoreRisk, RiskScoringError } from '../ops/risk-scoring';
import type { HighImpactAction, RiskActor, RiskEvaluationInput } from '../ops/risk-scoring';
import { approve, ApprovalError } from '../ops/maintainer-approval';
import type { ApprovalRequest, ApprovalOutcome } from '../ops/maintainer-approval';

export const riskRouter = Router();

function resolveActor(req: Request): RiskActor | null {
  // Preferred: auth middleware populates req.actor from the session.
  const injected = (req as Request & { actor?: RiskActor }).actor;
  if (injected && typeof injected.id === 'string' && Array.isArray(injected.roles)) {
    return injected;
  }
  // Fallback for the dependency-free MVP server only. The Postgres server must
  // set req.actor from the session and ignore body.caller entirely.
  const bodyCaller = (req.body as { caller?: RiskActor } | undefined)?.caller;
  if (bodyCaller && typeof bodyCaller === 'object' && Array.isArray(bodyCaller.roles)) {
    return bodyCaller;
  }
  return null;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

riskRouter.post('/score', (req, res) => {
  try {
    const caller = resolveActor(req);
    if (!caller) {
      sendError(res, 401, 'UNAUTHENTICATED', 'An authenticated actor is required to score an action.');
      return;
    }
    authorizeRiskScorer(caller);

    const input = (req.body as { input?: RiskEvaluationInput } | undefined)?.input;
    if (!input) {
      sendError(res, 400, 'INVALID_INPUT', 'Request body must include an "input" object.');
      return;
    }

    const score = scoreRisk(input);
    res.status(200).json({ success: true, data: score });
  } catch (err) {
    if (err instanceof RiskScoringError) {
      const status = err.code === 'UNAUTHORIZED' ? 403 : 400;
      sendError(res, status, err.code, err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Risk scoring failed unexpectedly.');
  }
});

riskRouter.post('/approve', (req, res) => {
  try {
    const caller = resolveActor(req);
    if (!caller) {
      sendError(res, 401, 'UNAUTHENTICATED', 'An authenticated actor is required to approve an action.');
      return;
    }

    const body = req.body as {
      score?: ApprovalRequest['score'];
      action?: HighImpactAction;
      justification?: string;
    } | undefined;

    if (!body?.score) {
      sendError(res, 400, 'INVALID_SCORE', 'Request body must include an evaluated "score".');
      return;
    }

    const outcome: ApprovalOutcome = approve({
      score: body.score,
      approver: caller,
      action: body.action,
      justification: body.justification,
    });
    res.status(200).json({ success: true, data: outcome });
  } catch (err) {
    if (err instanceof ApprovalError) {
      const status = err.code === 'UNAUTHORIZED_APPROVER' ? 403 : 400;
      sendError(res, status, err.code, err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Approval evaluation failed unexpectedly.');
  }
});
