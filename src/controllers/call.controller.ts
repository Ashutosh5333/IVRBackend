import { Request, Response, NextFunction } from 'express';
import * as callService from '../services/call/call.service';
import { scheduleBulkCalls } from '../queues';
import { sendSuccess, sendError } from '../utils/response';
import { queryOne, query } from '../config/database';
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

    const valid = await query<{ id: string }>(
      `SELECT id FROM candidates WHERE id = ANY($1) AND tenant_id = $2 AND status = 'pending'`,
      [candidate_ids, req.user.tenant_id]
    );

    if (valid.length === 0) {
      sendError(res, 'No valid pending candidates found', 400);
      return;
    }

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
// FIX: read question_set_id directly off call_sessions (set at
// call-creation time in initiateCall). No more re-guessing by
// tenant+role, which silently failed when no default set existed.
export const webhookConnect = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const session = await queryOne<{ id: string; question_set_id: string | null }>(
      'SELECT id, question_set_id FROM call_sessions WHERE id = $1',
      [sessionId]
    );

    if (!session) {
      res.type('text/xml').send(
        `<?xml version="1.0"?><Response><Say>Error. Goodbye.</Say><Hangup/></Response>`
      );
      return;
    }

    if (!session.question_set_id) {
      res.type('text/xml').send(
        callService.buildEndCallTwiML('Sorry, no questions were configured for this call. Goodbye.')
      );
      return;
    }

    const twiml = await callService.buildGreetingTwiML(sessionId, session.question_set_id);
    res.type('text/xml').send(twiml);
  } catch (error) {
    next(error);
  }
};

// ── Webhook: Twilio answer recording received ────────────────
// FIX: same — read question_set_id directly from call_sessions.
export const webhookAnswer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { sessionId, questionIndex } = req.params;
    const recordingUrl = (req.body as Record<string, string>).RecordingUrl;
    const nextIndex = parseInt(questionIndex, 10);

    const session = await queryOne<{ question_set_id: string | null }>(
      'SELECT question_set_id FROM call_sessions WHERE id = $1',
      [sessionId]
    );

    if (!session?.question_set_id) {
      res.type('text/xml').send(
        callService.buildEndCallTwiML('Sorry, a technical issue occurred. Goodbye.')
      );
      return;
    }

    const twiml = await callService.buildQuestionTwiML(
      sessionId,
      session.question_set_id,
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
