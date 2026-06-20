import twilio from 'twilio';
import axios from 'axios';
import { query, queryOne } from '../../config/database';
import { setActiveCall, removeActiveCall, acquireLock, releaseLock } from '../../config/redis';
import { AppError } from '../../middleware/error.middleware';
import {
  Candidate, CallSession, CallStatus, CandidateStatus, QuestionSet, Question, JobRole
} from '../../types';
import { logger } from '../../utils/logger';
import { getSocketServer } from '../../sockets';
import { getOrCreateDefaultQuestionSet } from '../question/question.service';
import { addTranscriptJob } from '../../queues';

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
    return response.data.audioContent as string;
  } catch (error) {
    logger.error('TTS failed', error);
    throw error;
  }
};

// ── Transcribe audio with Deepgram ────────────────────────────
// FIX: Twilio recording URLs require Basic Auth (Account SID + Auth Token)
// to fetch — Deepgram was getting 401 from Twilio because no credentials
// were passed. We now fetch the audio ourselves with auth, then send the
// raw bytes to Deepgram instead of asking Deepgram to fetch the URL itself.
export const transcribeAudio = async (audioUrl: string): Promise<string> => {
  try {
    // Twilio recording URLs need .mp3/.wav suffix + Basic Auth to fetch directly
    const audioResponse = await axios.get(`${audioUrl}.mp3`, {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID!,
        password: process.env.TWILIO_AUTH_TOKEN!,
      },
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en-IN&punctuate=true&smart_format=true',
      audioResponse.data,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/mpeg',
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
  const lockKey = `call:${candidateId}`;
  const locked = await acquireLock(lockKey, 120);
  if (!locked) {
    throw new AppError('Call already in progress for this candidate', 409);
  }

  let statusUpdated = false;

  try {
    const candidate = await queryOne<Candidate>(
      'SELECT * FROM candidates WHERE id = $1 AND tenant_id = $2',
      [candidateId, tenantId]
    );
    if (!candidate) throw new AppError('Candidate not found', 404);

    if (candidate.status === CandidateStatus.CALLING) {
      throw new AppError('Candidate is already being called', 409);
    }

    const questionSet = await getOrCreateDefaultQuestionSet(
      tenantId,
      candidate.job_role as JobRole,
      initiatedBy
    );

    let cleanPhone = candidate.phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = cleanPhone.substring(1);
    }
    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone;
    }
    const formattedPhone = `+${cleanPhone}`;

    const sessionResult = await query<CallSession>(
      `INSERT INTO call_sessions (tenant_id, candidate_id, campaign_id, status, initiated_by, question_set_id)
       VALUES ($1, $2, $3, $4::varchar, $5, $6) RETURNING *`,
      [tenantId, candidateId, campaignId ?? null, CallStatus.QUEUED, initiatedBy, questionSet.id]
    );
    const session = sessionResult[0];

    await query(
      `UPDATE candidates SET status = $1::varchar, call_attempts = call_attempts + 1,
       last_called_at = NOW() WHERE id = $2`,
      [CandidateStatus.CALLING, candidateId]
    );
    statusUpdated = true;

    // Notify frontend immediately — candidate is now "calling"
    const io = getSocketServer();
    io.to(`tenant:${tenantId}`).emit('candidate:status_updated', {
      candidate_id: candidateId,
      status: 'calling',
    });

    const call = await twilioClient.calls.create({
      to: formattedPhone,
      from: process.env.TWILIO_PHONE_NUMBER!,
      url: `${BASE_URL}/api/calls/webhook/connect/${session.id}`,
      statusCallback: `${BASE_URL}/api/calls/webhook/status/${session.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${BASE_URL}/api/calls/webhook/recording/${session.id}`,
      timeout: 30,
      machineDetection: 'Enable',
    });

    await query(
      'UPDATE call_sessions SET twilio_call_sid = $1, status = $2::varchar, started_at = NOW() WHERE id = $3',
      [call.sid, CallStatus.INITIATED, session.id]
    );

    await setActiveCall(tenantId, candidateId, call.sid);

    io.to(`tenant:${tenantId}`).emit('call:initiated', {
      call_session_id: session.id,
      candidate_id: candidateId,
      status: CallStatus.INITIATED,
    });

    logger.info(`Call initiated: ${call.sid} → ${formattedPhone} (question_set: ${questionSet.id})`);
    return { ...session, twilio_call_sid: call.sid, question_set_id: questionSet.id } as CallSession;
  } catch (error) {
    if (statusUpdated) {
      try {
        await query(
          `UPDATE candidates SET status = 'pending'::varchar,
           call_attempts = GREATEST(0, call_attempts - 1)
           WHERE id = $1`,
          [candidateId]
        );
      } catch (dbError) {
        logger.error('Failed to rollback candidate status after failed call initialization', dbError);
      }
    }
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
  if (!qSet || !(qSet.questions as Question[])?.length) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Aditi">Sorry, there was a technical issue. Goodbye.</Say><Hangup/></Response>`;
  }

  const firstQuestion = (qSet.questions as Question[])[0];
  const greeting = `Hello! This is an automated screening call from the HR team.
    I will be asking you a few questions as part of your job application.
    Please answer each question clearly after the beep. Let's begin.`;

  // FIX: shorter timeout so the IVR feels snappier, and removed any
  // synchronous network call from this path entirely (it never reads
  // a recording here, so this part was always fast — the slowness
  // was 100% from the blocking Deepgram call in buildQuestionTwiML).
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
// FIX (the big one): this used to call `transcribeAudio()` and `await`
// it before responding to Twilio — meaning every single question after
// the first one was delayed by however long Deepgram took (or hung on
// the 401 error before timing out at 30s!). That's your "too slow"
// symptom. Transcription is now queued to BullMQ and processed in the
// background; the next question plays immediately.
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

  // Queue transcription instead of blocking on it
  if (previousRecordingUrl && questionIndex > 0) {
    const prevQuestion = questions[questionIndex - 1];
    if (prevQuestion) {
      // Store a placeholder immediately so the UI has something,
      // the real transcript fills in moments later via the queue.
      await query(
        `UPDATE call_sessions
         SET answers = COALESCE(answers, '[]'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify([{
            question_id: prevQuestion.id,
            question_text: prevQuestion.text,
            answer: '', // filled in by transcript worker
          }]),
          sessionId,
        ]
      );

      await addTranscriptJob({
        call_session_id: sessionId,
        recording_url: previousRecordingUrl,
        tenant_id: '', // not required by current worker logic
      });
    }
  }

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
// FIX: explicit ::varchar casts on every parameter that touches the
// `status` column — this is what was throwing "inconsistent types
// deduced for parameter $1" and silently failing to update status,
// which is why candidates got stuck on "Calling..." forever.
export const handleCallStatusUpdate = async (
  sessionId: string,
  twilioStatus: string,
  duration?: string
): Promise<void> => {
  const statusMap: Record<string, CallStatus> = {
    queued: CallStatus.QUEUED,
    initiated: CallStatus.INITIATED,
    ringing: CallStatus.RINGING,
    'in-progress': CallStatus.IN_PROGRESS,
    completed: CallStatus.COMPLETED,
    failed: CallStatus.FAILED,
    busy: CallStatus.BUSY,
    'no-answer': CallStatus.NO_ANSWER,
    canceled: CallStatus.FAILED,
  };

  const internalStatus = statusMap[twilioStatus] ?? CallStatus.FAILED;
  const isTerminal = ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(twilioStatus);

  await query(
    `UPDATE call_sessions
     SET status = $1::varchar,
         duration_seconds = $2,
         ended_at = CASE WHEN $3 THEN NOW() ELSE ended_at END
     WHERE id = $4`,
    [internalStatus, duration ? parseInt(duration, 10) : null, isTerminal, sessionId]
  );

  const session = await queryOne<{ candidate_id: string; tenant_id: string }>(
    'SELECT candidate_id, tenant_id FROM call_sessions WHERE id = $1',
    [sessionId]
  );
  if (!session) return;

  const lockKey = `call:${session.candidate_id}`;
  const io = getSocketServer();

  // ── Only flip candidate status on TERMINAL Twilio statuses.
  // "ringing" / "in-progress" should keep showing "Calling..." —
  // this matches what you asked for.
  if (twilioStatus === 'completed') {
    await query(
      `UPDATE candidates SET status = 'call_done'::varchar, updated_at = NOW() WHERE id = $1`,
      [session.candidate_id]
    );
    await removeActiveCall(session.tenant_id, session.candidate_id);
    await releaseLock(lockKey);

    io.to(`tenant:${session.tenant_id}`).emit('candidate:status_updated', {
      candidate_id: session.candidate_id,
      status: 'call_done',
    });
  } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(twilioStatus)) {
    await query(
      `UPDATE candidates SET status = 'no_answer'::varchar, updated_at = NOW() WHERE id = $1`,
      [session.candidate_id]
    );
    await removeActiveCall(session.tenant_id, session.candidate_id);
    await releaseLock(lockKey);

    io.to(`tenant:${session.tenant_id}`).emit('candidate:status_updated', {
      candidate_id: session.candidate_id,
      status: 'no_answer',
    });
  }
  // "queued" / "initiated" / "ringing" / "in-progress" → no candidate
  // status change here; it was already set to "calling" at dial time
  // in initiateCall(), so the UI correctly shows "Calling..." for the
  // entire duration of the call and only flips once it's truly over.

  io.to(`tenant:${session.tenant_id}`).emit('call:status', {
    call_session_id: sessionId,
    candidate_id: session.candidate_id,
    status: internalStatus,
    duration: duration ? parseInt(duration, 10) : undefined,
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

  const answered = answers.filter((a) => a.answer?.trim().length > 0).length;
  const score = Math.round((answered / answers.length) * 100);

  await query('UPDATE call_sessions SET score = $1 WHERE id = $2', [score, sessionId]);
  return score;
};
