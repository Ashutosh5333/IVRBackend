import { Request, Response, NextFunction } from 'express';
import * as callService from '../services/call/call.service';
import { scheduleBulkCalls, addCallJob } from '../queues';
import { sendSuccess, sendError } from '../utils/response';
import { queryOne } from '../config/database';
import { Candidate, JobRole } from '../types';
import { getOrCreateDefaultQuestionSet } from '../services/question/question.service';

// ── Initiate single call ──────────────────────────────────────
export const initiateCall = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const { candidate_id, campaign_id } = req.body as {
      candidate_id: string;
      campaign_id?: string;
    };

    const session = await callService.initiateCall(
      candidate_id,
      req.user.tenant_id,
      req.user.id,
      campaign_id
    );

    sendSuccess(res, session, 'Call initiated');
  } catch (error) {
    next(error);
  }
};

// ── Start bulk calls for selected candidates ──────────────────
export const startBulkCalls = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const { candidate_ids, question_set_id, campaign_id } = req.body as {
      candidate_ids: string[];
      question_set_id?: string;
      campaign_id?: string;
    };

    if (!candidate_ids?.length) {
      sendError(res, 'candidate_ids array required', 400);
      return;
    }

    // Validate all candidates belong to this tenant
    const { query } = await import('../config/database');
    const valid = await query<{ id: string }>(
      `SELECT id FROM candidates WHERE id = ANY($1) AND tenant_id = $2 AND status = 'pending'`,
      [candidate_ids, req.user.tenant_id]
    );

    if (valid.length === 0) {
      sendError(res, 'No valid pending candidates found', 400);
      return;
    }

    // Get question set or use default
    let qSetId = question_set_id;
    if (!qSetId) {
      const firstCandidate = await queryOne<Candidate>(
        'SELECT job_role FROM candidates WHERE id = $1',
        [valid[0].id]
      );
      if (firstCandidate) {
        const qSet = await getOrCreateDefaultQuestionSet(
          req.user.tenant_id,
          firstCandidate.job_role as JobRole,
          req.user.id
        );
        qSetId = qSet.id;
      }
    }

    if (!qSetId) { sendError(res, 'No question set available', 400); return; }

    await scheduleBulkCalls(
      valid.map((c) => c.id),
      req.user.tenant_id,
      qSetId,
      campaign_id
    );

    sendSuccess(res, { queued: valid.length }, `${valid.length} calls queued`);
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// TWILIO WEBHOOKS (public endpoints - no auth needed)
// ─────────────────────────────────────────────────────────────

// ── Webhook: Twilio connects call → return greeting TwiML ─────
export const webhookConnect = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const session = await queryOne<{ id: string; candidate_id: string }>(
      'SELECT id, candidate_id FROM call_sessions WHERE id = $1',
      [sessionId]
    );
    if (!session) {
      res.type('text/xml').send(
        `<?xml version="1.0"?><Response><Say>Error. Goodbye.</Say><Hangup/></Response>`
      );
      return;
    }

    // Get question set for this candidate
    const candidate = await queryOne<{ job_role: JobRole; tenant_id: string }>(
      'SELECT job_role, tenant_id FROM candidates WHERE id = $1',
      [session.candidate_id]
    );

    const { query } = await import('../config/database');
    const qSetRows = await query<{ id: string }>(
      `SELECT id FROM question_sets WHERE tenant_id = $1 AND job_role = $2 AND is_default = true LIMIT 1`,
      [candidate?.tenant_id, candidate?.job_role]
    );

    const qSetId = qSetRows[0]?.id;
    if (!qSetId) {
      res.type('text/xml').send(callService.buildEndCallTwiML('Thank you for your time. Goodbye.'));
      return;
    }

    const twiml = await callService.buildGreetingTwiML(sessionId, qSetId);
    res.type('text/xml').send(twiml);
  } catch (error) {
    next(error);
  }
};

// ── Webhook: Twilio answer recording received ────────────────
export const webhookAnswer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { sessionId, questionIndex } = req.params;
    const recordingUrl = (req.body as Record<string, string>).RecordingUrl;
    const nextIndex = parseInt(questionIndex);

    const session = await queryOne<{ candidate_id: string }>(
      'SELECT candidate_id FROM call_sessions WHERE id = $1', [sessionId]
    );
    const candidate = await queryOne<{ job_role: JobRole; tenant_id: string }>(
      'SELECT job_role, tenant_id FROM candidates WHERE id = $1', [session?.candidate_id]
    );

    const { query } = await import('../config/database');
    const qSetRows = await query<{ id: string }>(
      `SELECT id FROM question_sets WHERE tenant_id = $1 AND job_role = $2 AND is_default = true LIMIT 1`,
      [candidate?.tenant_id, candidate?.job_role]
    );

    const twiml = await callService.buildQuestionTwiML(
      sessionId,
      qSetRows[0]?.id ?? '',
      nextIndex,
      recordingUrl
    );

    res.type('text/xml').send(twiml);
  } catch (error) {
    next(error);
  }
};

// ── Webhook: Twilio call status update ────────────────────────
export const webhookStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { sessionId } = req.params;
  const body = req.body as Record<string, string>;

  await callService.handleCallStatusUpdate(
    sessionId,
    body.CallStatus,
    body.CallDuration
  );

  res.status(200).send('OK');
};

// ── Webhook: Recording ready ──────────────────────────────────
export const webhookRecording = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { sessionId } = req.params;
  const body = req.body as Record<string, string>;

  if (body.RecordingUrl) {
    await callService.handleRecordingReady(sessionId, body.RecordingUrl);
  }

  res.status(200).send('OK');
};

// ── Get call sessions for a candidate ────────────────────────
export const getCallSessions = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const { query } = await import('../config/database');
    const sessions = await query(
      `SELECT cs.*, c.name as candidate_name, c.phone
       FROM call_sessions cs
       JOIN candidates c ON cs.candidate_id = c.id
       WHERE cs.tenant_id = $1
       ORDER BY cs.created_at DESC
       LIMIT 100`,
      [req.user.tenant_id]
    );

    sendSuccess(res, sessions);
  } catch (error) {
    next(error);
  }
};

// ── Get single call session detail ───────────────────────────
export const getCallSession = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const { query } = await import('../config/database');
    const sessions = await query(
      `SELECT cs.*, c.name as candidate_name, c.phone, c.job_role
       FROM call_sessions cs
       JOIN candidates c ON cs.candidate_id = c.id
       WHERE cs.id = $1 AND cs.tenant_id = $2`,
      [req.params.id, req.user.tenant_id]
    );

    if (!sessions[0]) { sendError(res, 'Session not found', 404); return; }
    sendSuccess(res, sessions[0]);
  } catch (error) {
    next(error);
  }
};
