import twilio from 'twilio';
import axios from 'axios';
import { query, queryOne } from '../../config/database';
import { setActiveCall, removeActiveCall, acquireLock, releaseLock } from '../../config/redis';
import { AppError } from '../../middleware/error.middleware';
import {
  Candidate, CallSession, CallStatus, CandidateStatus, QuestionSet, Question
} from '../../types';
import { logger } from '../../utils/logger';
import { getSocketServer } from '../../sockets';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL;

// ── Text-to-Speech via Google TTS ────────────────────────────
export const textToSpeech = async (text: string): Promise<string> => {
  try {
    const response = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
      {
        input: { text },
        voice: { languageCode: 'en-IN', name: 'en-IN-Wavenet-D', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95, pitch: 0 },
      },
      { timeout: 10000 }
    );
    return response.data.audioContent as string; // base64 MP3
  } catch (error) {
    logger.error('TTS failed', error);
    throw error;
  }
};

// ── Transcribe audio with Deepgram ────────────────────────────
export const transcribeAudio = async (audioUrl: string): Promise<string> => {
  try {
    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en-IN&punctuate=true&smart_format=true',
      { url: audioUrl },
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    return response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  } catch (error) {
    logger.error('Deepgram transcription failed', error);
    return '';
  }
};

// ── Initiate outbound call ────────────────────────────────────
export const initiateCall = async (
  candidateId: string,
  tenantId: string,
  initiatedBy: string,
  campaignId?: string
): Promise<CallSession> => {
  // Distributed lock - prevent duplicate call to same candidate
  const lockKey = `call:${candidateId}`;
  const locked = await acquireLock(lockKey, 120);
  if (!locked) {
    throw new AppError('Call already in progress for this candidate', 409);
  }

  try {
    const candidate = await queryOne<Candidate>(
      'SELECT * FROM candidates WHERE id = $1 AND tenant_id = $2',
      [candidateId, tenantId]
    );
    if (!candidate) throw new AppError('Candidate not found', 404);

    if (candidate.status === CandidateStatus.CALLING) {
      throw new AppError('Candidate is already being called', 409);
    }

    // Create call session
    const sessionResult = await query<CallSession>(
      `INSERT INTO call_sessions (tenant_id, candidate_id, campaign_id, status, initiated_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, candidateId, campaignId ?? null, CallStatus.QUEUED, initiatedBy]
    );
    const session = sessionResult[0];

    // Update candidate status
    await query(
      `UPDATE candidates SET status = $1, call_attempts = call_attempts + 1,
       last_called_at = NOW() WHERE id = $2`,
      [CandidateStatus.CALLING, candidateId]
    );

    // Initiate Twilio call
    const call = await twilioClient.calls.create({
      to: candidate.phone,
      from: process.env.TWILIO_PHONE_NUMBER!,
      url: `${BASE_URL}/api/calls/webhook/connect/${session.id}`,
      statusCallback: `${BASE_URL}/api/calls/webhook/status/${session.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${BASE_URL}/api/calls/webhook/recording/${session.id}`,
      timeout: 30, // Ring for 30 seconds
      machineDetection: 'Enable', // Detect voicemail
    });

    // Save Twilio SID
    await query(
      'UPDATE call_sessions SET twilio_call_sid = $1, status = $2, started_at = NOW() WHERE id = $3',
      [call.sid, CallStatus.INITIATED, session.id]
    );

    // Track in Redis
    await setActiveCall(tenantId, candidateId, call.sid);

    // Emit socket event to HR dashboard
    const io = getSocketServer();
    io.to(`tenant:${tenantId}`).emit('call:initiated', {
      call_session_id: session.id,
      candidate_id: candidateId,
      status: CallStatus.INITIATED,
    });

    logger.info(`Call initiated: ${call.sid} → ${candidate.phone}`);
    return { ...session, twilio_call_sid: call.sid };
  } catch (error) {
    await releaseLock(lockKey);
    throw error;
  }
};

// ── TwiML: Initial greeting + first question ──────────────────
export const buildGreetingTwiML = async (
  sessionId: string,
  questionSetId: string
): Promise<string> => {
  const qSet = await queryOne<QuestionSet>(
    'SELECT * FROM question_sets WHERE id = $1',
    [questionSetId]
  );
  if (!qSet) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Aditi">Sorry, there was a technical issue. Goodbye.</Say><Hangup/></Response>`;
  }

  const firstQuestion = (qSet.questions as Question[])[0];
  const greeting = `Hello! This is an automated screening call from the HR team. 
    I will be asking you a few questions as part of your job application. 
    Please answer each question clearly after the beep. Let's begin.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" rate="slow">${greeting}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Aditi">Question 1: ${firstQuestion.text}</Say>
  <Record
    action="${BASE_URL}/api/calls/webhook/answer/${sessionId}/1"
    maxLength="60"
    timeout="5"
    playBeep="true"
    transcribe="false"
  />
</Response>`;
};

// ── TwiML: Follow-up questions ────────────────────────────────
export const buildQuestionTwiML = async (
  sessionId: string,
  questionSetId: string,
  questionIndex: number,
  previousRecordingUrl?: string
): Promise<string> => {
  const qSet = await queryOne<QuestionSet>(
    'SELECT * FROM question_sets WHERE id = $1',
    [questionSetId]
  );

  if (!qSet) {
    return buildEndCallTwiML('Technical error. Thank you for your time. Goodbye.');
  }

  const questions = qSet.questions as Question[];

  // Save previous answer transcript if available
  if (previousRecordingUrl && questionIndex > 0) {
    const transcript = await transcribeAudio(previousRecordingUrl);
    const prevQuestion = questions[questionIndex - 1];

    await query(
      `UPDATE call_sessions
       SET answers = answers || $1::jsonb,
           transcript = transcript || $2::jsonb
       WHERE id = $3`,
      [
        JSON.stringify([{
          question_id: prevQuestion.id,
          question_text: prevQuestion.text,
          answer: transcript,
        }]),
        JSON.stringify([
          { speaker: 'agent', text: prevQuestion.text, timestamp: Date.now() },
          { speaker: 'candidate', text: transcript, timestamp: Date.now() + 100 },
        ]),
        sessionId,
      ]
    );

    // Emit live transcript
    const io = getSocketServer();
    const session = await queryOne<CallSession>(
      'SELECT tenant_id, candidate_id FROM call_sessions WHERE id = $1', [sessionId]
    );
    if (session) {
      io.to(`tenant:${session.tenant_id}`).emit('call:transcript', {
        call_session_id: sessionId,
        entry: { speaker: 'candidate', text: transcript, timestamp: Date.now() },
      });
    }
  }

  // Check if all questions answered
  if (questionIndex >= questions.length) {
    return buildEndCallTwiML(
      'Thank you for answering all the questions. Our HR team will review your responses and get back to you soon. Have a great day!'
    );
  }

  const currentQuestion = questions[questionIndex];
  const questionNum = questionIndex + 1;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Question ${questionNum}: ${currentQuestion.text}</Say>
  <Record
    action="${BASE_URL}/api/calls/webhook/answer/${sessionId}/${questionIndex + 1}"
    maxLength="60"
    timeout="5"
    playBeep="true"
    transcribe="false"
  />
</Response>`;
};

// ── TwiML: End call ───────────────────────────────────────────
export const buildEndCallTwiML = (message: string): string => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" rate="slow">${message}</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`;
};

// ── Handle call status webhook ────────────────────────────────
export const handleCallStatusUpdate = async (
  sessionId: string,
  twilioStatus: string,
  duration?: string
): Promise<void> => {
  const statusMap: Record<string, CallStatus> = {
    initiated: CallStatus.INITIATED,
    ringing: CallStatus.RINGING,
    'in-progress': CallStatus.IN_PROGRESS,
    completed: CallStatus.COMPLETED,
    failed: CallStatus.FAILED,
    'no-answer': CallStatus.NO_ANSWER,
    busy: CallStatus.BUSY,
  };

  const status = statusMap[twilioStatus] ?? CallStatus.FAILED;

  const session = await queryOne<CallSession>(
    'SELECT * FROM call_sessions WHERE id = $1',
    [sessionId]
  );
  if (!session) return;

  await query(
    `UPDATE call_sessions SET status = $1, duration_seconds = $2,
     ended_at = CASE WHEN $1 IN ('completed','failed','no_answer','busy') THEN NOW() ELSE ended_at END
     WHERE id = $3`,
    [status, duration ? parseInt(duration) : null, sessionId]
  );

  // Map to candidate status
  const candidateStatusMap: Partial<Record<CallStatus, CandidateStatus>> = {
    [CallStatus.COMPLETED]: CandidateStatus.CALL_DONE,
    [CallStatus.NO_ANSWER]: CandidateStatus.NO_ANSWER,
    [CallStatus.FAILED]: CandidateStatus.NO_ANSWER,
    [CallStatus.BUSY]: CandidateStatus.NO_ANSWER,
  };

  const newCandidateStatus = candidateStatusMap[status];
  if (newCandidateStatus) {
    await query(
      'UPDATE candidates SET status = $1 WHERE id = $2',
      [newCandidateStatus, session.candidate_id]
    );
    await removeActiveCall(session.tenant_id, session.candidate_id);
  }

  // Emit socket update
  const io = getSocketServer();
  io.to(`tenant:${session.tenant_id}`).emit('call:status', {
    call_session_id: sessionId,
    candidate_id: session.candidate_id,
    status,
    duration: duration ? parseInt(duration) : undefined,
  });
};

// ── Handle recording webhook ──────────────────────────────────
export const handleRecordingReady = async (
  sessionId: string,
  recordingUrl: string
): Promise<void> => {
  await query(
    'UPDATE call_sessions SET recording_url = $1 WHERE id = $2',
    [recordingUrl, sessionId]
  );
  logger.info(`Recording saved for session ${sessionId}`);
};

// ── Score a completed call session ────────────────────────────
export const scoreCallSession = async (sessionId: string): Promise<number> => {
  const session = await queryOne<CallSession>(
    'SELECT * FROM call_sessions WHERE id = $1', [sessionId]
  );
  if (!session?.answers) return 0;

  const answers = session.answers as Array<{
    question_id: string;
    answer: string;
    score?: number;
  }>;

  if (answers.length === 0) return 0;

  // Simple scoring: % of questions answered (non-empty)
  const answered = answers.filter((a) => a.answer?.trim().length > 0).length;
  const score = Math.round((answered / answers.length) * 100);

  await query('UPDATE call_sessions SET score = $1 WHERE id = $2', [score, sessionId]);
  return score;
};
