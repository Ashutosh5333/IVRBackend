import { Queue, Worker, Job } from 'bullmq';
import dotenv from 'dotenv';
dotenv.config();

import { CallJobData, EmailJobData, ResumeJobData, TranscriptJobData } from '../types';
import { logger } from '../utils/logger';

// ── BullMQ Redis connection (separate from app redis client) ──
// BullMQ requires maxRetriesPerRequest: null and its own connection.
const redisUrl = (process.env.REDIS_URL ?? '').startsWith('redis://')
  ? (process.env.REDIS_URL ?? '').replace('redis://', 'rediss://')
  : (process.env.REDIS_URL ?? '');

const bullMQConnection = {
  connection: {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: { rejectUnauthorized: false },
  },
};

// ── Queue definitions ─────────────────────────────────────────
export const callQueue = new Queue<CallJobData>('calls', bullMQConnection);
export const emailQueue = new Queue<EmailJobData>('emails', bullMQConnection);
export const resumeQueue = new Queue<ResumeJobData>('resumes', bullMQConnection);
export const transcriptQueue = new Queue<TranscriptJobData>('transcripts', bullMQConnection);

// ── Add job helpers ───────────────────────────────────────────
export const addCallJob = async (
  data: CallJobData,
  delayMs: number = 0
): Promise<void> => {
  await callQueue.add('initiate-call', data, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'fixed', delay: 30 * 60 * 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
};

export const addEmailJob = async (data: EmailJobData): Promise<void> => {
  await emailQueue.add('send-email', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
};

export const addResumeJob = async (data: ResumeJobData): Promise<void> => {
  await resumeQueue.add('parse-resume', data, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
    removeOnComplete: 50,
    removeOnFail: 20,
  });
};

export const addTranscriptJob = async (data: TranscriptJobData): Promise<void> => {
  await transcriptQueue.add('process-transcript', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
};

// ── Bulk call scheduling ──────────────────────────────────────
export const scheduleBulkCalls = async (
  candidateIds: string[],
  tenantId: string,
  questionSetId: string,
  campaignId?: string
): Promise<void> => {
  const jobs = candidateIds.map((candidate_id, index) => ({
    name: 'initiate-call',
    data: {
      candidate_id,
      tenant_id: tenantId,
      question_set_id: questionSetId,
      campaign_id: campaignId,
      attempt_number: 1,
    } as CallJobData,
    opts: {
      delay: index * 2000,
      attempts: 3,
      backoff: { type: 'fixed' as const, delay: 30 * 60 * 1000 },
    },
  }));

  await callQueue.addBulk(jobs);
  logger.info(`Scheduled ${candidateIds.length} calls for tenant ${tenantId}`);
};

// ── Worker definitions (lazy — only created if enabled) ────────
type WorkerName = 'calls' | 'emails' | 'resumes' | 'transcripts';

// Reduce idle Redis polling — check stalled jobs every 60s instead of default 5s
const WORKER_OPTS = { stalledInterval: 60_000 };

const createCallWorker = () =>
  new Worker<CallJobData>(
    'calls',
    async (job: Job<CallJobData>) => {
      const { initiateCall } = await import('../services/call/call.service');
      const { candidate_id, tenant_id, campaign_id } = job.data;
      await initiateCall(candidate_id, tenant_id, 'system', campaign_id);
    },
    { ...bullMQConnection, concurrency: 5, ...WORKER_OPTS }
  );

const createEmailWorker = () =>
  new Worker<EmailJobData>(
    'emails',
    async (job: Job<EmailJobData>) => {
      const { sendEmailJob } = await import('../services/email/email.service');
      await sendEmailJob(job.data);
    },
    { ...bullMQConnection, concurrency: 10, ...WORKER_OPTS }
  );

const createResumeWorker = () =>
  new Worker<ResumeJobData>(
    'resumes',
    async (job: Job<ResumeJobData>) => {
      const { parseResumeWithAI, extractResumeText } = await import('../services/resume/resume.service');
      const { query } = await import('../config/database');
      const axios = await import('axios');

      const { candidate_id, tenant_id, resume_url, job_role } = job.data;

      const response = await axios.default.get(resume_url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      const text = await extractResumeText(buffer, 'application/pdf');
      const parsed = await parseResumeWithAI(text, job_role);

      await query(
        `UPDATE candidates SET resume_parsed = $1, fit_score = $2 WHERE id = $3 AND tenant_id = $4`,
        [JSON.stringify(parsed), parsed.job_fit[job_role] ?? 0, candidate_id, tenant_id]
      );
    },
    { ...bullMQConnection, concurrency: 3, ...WORKER_OPTS }
  );


const createTranscriptWorker = () =>
  new Worker<TranscriptJobData>(
    'transcripts',
    async (job: Job<TranscriptJobData>) => {
      const { transcribeAudio, scoreCallSession } = await import('../services/call/call.service');
      const { query, queryOne } = await import('../config/database');
      const { getSocketServer } = await import('../sockets');

      const { call_session_id, recording_url } = job.data;
      const transcript = await transcribeAudio(recording_url);

      // Fill in the most recently-added empty answer (the placeholder
      // written synchronously in buildQuestionTwiML) instead of
      // appending a brand new array entry.
      const session = await queryOne<{ answers: unknown; tenant_id: string; candidate_id: string }>(
        'SELECT answers, tenant_id, candidate_id FROM call_sessions WHERE id = $1',
        [call_session_id]
      );

      if (session?.answers) {
        const answers = session.answers as Array<{
          question_id: string;
          question_text: string;
          answer: string;
        }>;

        // Find last entry with an empty answer and fill it
        for (let i = answers.length - 1; i >= 0; i--) {
          if (!answers[i].answer) {
            answers[i].answer = transcript;
            break;
          }
        }

        await query(
          `UPDATE call_sessions
           SET answers = $1::jsonb,
               transcript = COALESCE(transcript, '[]'::jsonb) || $2::jsonb
           WHERE id = $3`,
          [
            JSON.stringify(answers),
            JSON.stringify([{ speaker: 'candidate', text: transcript, timestamp: Date.now() }]),
            call_session_id,
          ]
        );

        // Live update to HR dashboard
        const io = getSocketServer();
        io.to(`tenant:${session.tenant_id}`).emit('call:transcript', {
          call_session_id,
          entry: { speaker: 'candidate', text: transcript, timestamp: Date.now() },
        });
      }

      await scoreCallSession(call_session_id);
    },
    { ...bullMQConnection, concurrency: 5, ...WORKER_OPTS }
  );

  
// const createTranscriptWorker = () =>
//   new Worker<TranscriptJobData>(
//     'transcripts',
//     async (job: Job<TranscriptJobData>) => {
//       const { transcribeAudio, scoreCallSession } = await import('../services/call/call.service');
//       const { query } = await import('../config/database');

//       const { call_session_id, recording_url } = job.data;
//       const transcript = await transcribeAudio(recording_url);

//       await query(
//         `UPDATE call_sessions
//          SET transcript = transcript || $1::jsonb
//          WHERE id = $2`,
//         [
//           JSON.stringify([{ speaker: 'candidate', text: transcript, timestamp: Date.now() }]),
//           call_session_id,
//         ]
//       );

//       await scoreCallSession(call_session_id);
//     },
//     { ...bullMQConnection, concurrency: 5, ...WORKER_OPTS }
//   );

const WORKER_FACTORIES: Record<WorkerName, () => Worker> = {
  calls: createCallWorker,
  emails: createEmailWorker,
  resumes: createResumeWorker,
  transcripts: createTranscriptWorker,
};


export const startWorkers = (): void => {
  const configured = process.env.ACTIVE_WORKERS;
  const namesToStart: WorkerName[] = configured
    ? (configured.split(',').map((s) => s.trim()) as WorkerName[]).filter((n) => WORKER_FACTORIES[n])
    : (Object.keys(WORKER_FACTORIES) as WorkerName[]);

  if (namesToStart.length === 0) {
    logger.warn('No BullMQ workers started (ACTIVE_WORKERS is empty/invalid)');
    return;
  }

  const workers = namesToStart.map((name) => {
    const worker = WORKER_FACTORIES[name]();
    worker.on('completed', (job) => logger.info(`Job completed: ${name}/${job.id}`));
    worker.on('failed', (job, err) => logger.error(`Job failed: ${name}/${job?.id}`, err));
    worker.on('error', (err) => logger.error(`Worker error: ${name}`, err));
    return worker;
  });

  logger.info(`✅ BullMQ workers started: ${namesToStart.join(', ')} (${workers.length} total)`);
};







//  ===========================> Queue prev <==============================  //


// import { Queue, Worker, QueueEvents, Job } from 'bullmq';
// import { redis } from '../config/redis';
// import { CallJobData, EmailJobData, ResumeJobData, TranscriptJobData } from '../types';
// import { logger } from '../utils/logger';
// import dotenv from 'dotenv';
// dotenv.config();

// // BullMQ requires a separate Redis connection with maxRetriesPerRequest: null

// const redisUrl = (process.env.REDIS_URL ?? '').startsWith('redis://')
//   ? (process.env.REDIS_URL ?? '').replace('redis://', 'rediss://')
//   : (process.env.REDIS_URL ?? '');

// const bullMQConnection = {
//   connection: {
//     url: redisUrl,
//     maxRetriesPerRequest: null, // BullMQ requirement
//     enableReadyCheck: false,
//     tls: { rejectUnauthorized: false },
//   },
// };

// // ── Shared connection config ──────────────────────────────────
// // const connection = { connection: redis };


// // ── Queue definitions ─────────────────────────────────────────
// export const callQueue = new Queue<CallJobData>('calls', bullMQConnection);
// export const emailQueue = new Queue<EmailJobData>('emails', bullMQConnection);
// export const resumeQueue = new Queue<ResumeJobData>('resumes', bullMQConnection);
// export const transcriptQueue = new Queue<TranscriptJobData>('transcripts', bullMQConnection);

// // ── Add job helpers ───────────────────────────────────────────
// export const addCallJob = async (
//   data: CallJobData,
//   delayMs: number = 0
// ): Promise<void> => {
//   await callQueue.add('initiate-call', data, {
//     delay: delayMs,
//     attempts: 3,
//     backoff: { type: 'fixed', delay: 30 * 60 * 1000 }, // Retry after 30 min
//     removeOnComplete: 100,
//     removeOnFail: 50,
//   });
// };

// export const addEmailJob = async (data: EmailJobData): Promise<void> => {
//   await emailQueue.add('send-email', data, {
//     attempts: 3,
//     backoff: { type: 'exponential', delay: 5000 },
//     removeOnComplete: 100,
//     removeOnFail: 50,
//   });
// };

// export const addResumeJob = async (data: ResumeJobData): Promise<void> => {
//   await resumeQueue.add('parse-resume', data, {
//     attempts: 2,
//     backoff: { type: 'fixed', delay: 10000 },
//     removeOnComplete: 50,
//     removeOnFail: 20,
//   });
// };

// export const addTranscriptJob = async (data: TranscriptJobData): Promise<void> => {
//   await transcriptQueue.add('process-transcript', data, {
//     attempts: 2,
//     backoff: { type: 'exponential', delay: 5000 },
//     removeOnComplete: 100,
//     removeOnFail: 50,
//   });
// };

// // ── Bulk call scheduling ──────────────────────────────────────
// export const scheduleBulkCalls = async (
//   candidateIds: string[],
//   tenantId: string,
//   questionSetId: string,
//   campaignId?: string
// ): Promise<void> => {
//   const jobs = candidateIds.map((candidate_id, index) => ({
//     name: 'initiate-call',
//     data: {
//       candidate_id,
//       tenant_id: tenantId,
//       question_set_id: questionSetId,
//       campaign_id: campaignId,
//       attempt_number: 1,
//     } as CallJobData,
//     opts: {
//       delay: index * 2000, // Stagger calls by 2 seconds each
//       attempts: 3,
//       backoff: { type: 'fixed' as const, delay: 30 * 60 * 1000 },
//     },
//   }));

//   await callQueue.addBulk(jobs);
//   logger.info(`Scheduled ${candidateIds.length} calls for tenant ${tenantId}`);
// };

// // ── Workers ───────────────────────────────────────────────────
// export const startWorkers = (): void => {
//   // Call worker
//   const callWorker = new Worker<CallJobData>(
//     'calls',
//     async (job: Job<CallJobData>) => {
//       const { initiateCall } = await import('../services/call/call.service');
//       const { candidate_id, tenant_id, campaign_id } = job.data;
//       await initiateCall(candidate_id, tenant_id, 'system', campaign_id);
//     },
//     {
//       ...bullMQConnection,
//       concurrency: 5, // Max 5 concurrent call jobs globally across all workers
//     }
//   );

//   // Email worker
//   const emailWorker = new Worker<EmailJobData>(
//     'emails',
//     async (job: Job<EmailJobData>) => {
//       const { sendEmailJob } = await import('../services/email/email.service');
//       await sendEmailJob(job.data);
//     },
//     { ...bullMQConnection, concurrency: 10 }
//   );

//   // Resume worker
//   const resumeWorker = new Worker<ResumeJobData>(
//     'resumes',
//     async (job: Job<ResumeJobData>) => {
//       const { parseResumeWithAI } = await import('../services/resume/resume.service');
//       const { query } = await import('../config/database');
//       const axios = await import('axios');

//       const { candidate_id, tenant_id, resume_url, job_role } = job.data;

//       // Download resume
//       const response = await axios.default.get(resume_url, { responseType: 'arraybuffer' });
//       const buffer = Buffer.from(response.data);

//       const { extractResumeText } = await import('../services/resume/resume.service');
//       const text = await extractResumeText(buffer, 'application/pdf');
//       const parsed = await parseResumeWithAI(text, job_role);

//       await query(
//         `UPDATE candidates SET resume_parsed = $1, fit_score = $2 WHERE id = $3 AND tenant_id = $4`,
//         [JSON.stringify(parsed), parsed.job_fit[job_role] ?? 0, candidate_id, tenant_id]
//       );
//     },
//     { ...bullMQConnection, concurrency: 3 }
//   );

//   // Transcript worker
//   const transcriptWorker = new Worker<TranscriptJobData>(
//     'transcripts',
//     async (job: Job<TranscriptJobData>) => {
//       const { transcribeAudio, scoreCallSession } = await import('../services/call/call.service');
//       const { query } = await import('../config/database');

//       const { call_session_id, recording_url } = job.data;
//       const transcript = await transcribeAudio(recording_url);

//       await query(
//         `UPDATE call_sessions
//          SET transcript = transcript || $1::jsonb
//          WHERE id = $2`,
//         [
//           JSON.stringify([{ speaker: 'candidate', text: transcript, timestamp: Date.now() }]),
//           call_session_id,
//         ]
//       );

//       await scoreCallSession(call_session_id);
//     },
//     { ...bullMQConnection, concurrency: 5 }
//   );

//   // Worker event logging
//   [callWorker, emailWorker, resumeWorker, transcriptWorker].forEach((worker) => {
//     worker.on('completed', (job) => {
//       logger.info(`Job completed: ${worker.name}/${job.id}`);
//     });
//     worker.on('failed', (job, err) => {
//       logger.error(`Job failed: ${worker.name}/${job?.id}`, err);
//     });
//     worker.on('error', (err) => {
//       logger.error(`Worker error: ${worker.name}`, err);
//     });
//   });

//   logger.info('✅ All BullMQ workers started');
// };
