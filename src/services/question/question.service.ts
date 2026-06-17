import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../config/database';
import { AppError } from '../../middleware/error.middleware';
import { QuestionSet, Question, QuestionType, JobRole } from '../../types';

// ── Default questions per role ────────────────────────────────
export const DEFAULT_QUESTIONS: Record<JobRole, Question[]> = {
  [JobRole.AR_CALLER]: [
    { id: uuidv4(), text: 'How many years of experience do you have in AR calling?', type: QuestionType.NUMERIC, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'Are you familiar with denial management and claim follow-up?', type: QuestionType.YES_NO, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What insurance payers have you worked with?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
    { id: uuidv4(), text: 'Are you comfortable working night shifts for US healthcare clients?', type: QuestionType.YES_NO, is_mandatory: true, order: 4 },
    { id: uuidv4(), text: 'What is your current CTC and expected CTC?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 5 },
  ],
  [JobRole.MEDICAL_CODER]: [
    { id: uuidv4(), text: 'What coding certifications do you hold? CPC, CCS, or others?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'How many years of medical coding experience do you have?', type: QuestionType.NUMERIC, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'Which specialties have you coded for?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
    { id: uuidv4(), text: 'Are you familiar with ICD-10 and CPT coding?', type: QuestionType.YES_NO, is_mandatory: true, order: 4 },
    { id: uuidv4(), text: 'What is your coding accuracy rate in your current role?', type: QuestionType.OPEN_ENDED, is_mandatory: false, order: 5 },
  ],
  [JobRole.PAYMENT_POSTING]: [
    { id: uuidv4(), text: 'How many years of payment posting experience do you have?', type: QuestionType.NUMERIC, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'Are you familiar with EOB and ERA posting?', type: QuestionType.YES_NO, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What billing software have you used? Kareo, AdvancedMD, or others?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
    { id: uuidv4(), text: 'What is your expected salary?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 4 },
  ],
  [JobRole.SOFTWARE_ENGINEER]: [
    { id: uuidv4(), text: 'What programming languages and frameworks are you proficient in?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'How many years of software development experience do you have?', type: QuestionType.NUMERIC, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'Are you comfortable working in an Agile team environment?', type: QuestionType.YES_NO, is_mandatory: true, order: 3 },
    { id: uuidv4(), text: 'Can you describe your experience with cloud platforms like AWS or GCP?', type: QuestionType.OPEN_ENDED, is_mandatory: false, order: 4 },
    { id: uuidv4(), text: 'What is your current and expected CTC?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 5 },
  ],
  [JobRole.BILLING_SPECIALIST]: [
    { id: uuidv4(), text: 'How many years of medical billing experience do you have?', type: QuestionType.NUMERIC, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'Are you familiar with claim submission and follow-up processes?', type: QuestionType.YES_NO, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What EMR and billing systems have you worked with?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
    { id: uuidv4(), text: 'What is your expected salary?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 4 },
  ],
  [JobRole.OPERATIONS]: [
    { id: uuidv4(), text: 'Describe your experience in operations or team management.', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'How comfortable are you with data analysis and reporting?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What is your expected CTC?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
  ],
  [JobRole.CUSTOMER_SUPPORT]: [
    { id: uuidv4(), text: 'How many years of customer support experience do you have?', type: QuestionType.NUMERIC, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'Are you comfortable handling inbound and outbound calls?', type: QuestionType.YES_NO, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What CRM tools have you used?', type: QuestionType.OPEN_ENDED, is_mandatory: false, order: 3 },
    { id: uuidv4(), text: 'What is your expected salary?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 4 },
  ],
  [JobRole.OTHER]: [
    { id: uuidv4(), text: 'Please describe your current role and experience.', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 1 },
    { id: uuidv4(), text: 'What are your key skills relevant to this position?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 2 },
    { id: uuidv4(), text: 'What is your expected salary?', type: QuestionType.OPEN_ENDED, is_mandatory: true, order: 3 },
  ],
};

// ── Create question set ───────────────────────────────────────
export const createQuestionSet = async (
  tenantId: string,
  createdBy: string,
  data: { name: string; job_role: JobRole; questions: Question[]; is_default?: boolean }
): Promise<QuestionSet> => {
  const result = await query<QuestionSet>(
    `INSERT INTO question_sets (tenant_id, name, job_role, questions, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantId, data.name, data.job_role, JSON.stringify(data.questions),
     data.is_default ?? false, createdBy]
  );
  return result[0];
};

// ── Get question sets for tenant ──────────────────────────────
export const getQuestionSets = async (
  tenantId: string,
  jobRole?: JobRole
): Promise<QuestionSet[]> => {
  const params: unknown[] = [tenantId];
  let sql = 'SELECT * FROM question_sets WHERE (tenant_id = $1 OR tenant_id IS NULL)';
  if (jobRole) {
    sql += ' AND job_role = $2';
    params.push(jobRole);
  }
  sql += ' ORDER BY is_default DESC, created_at DESC';
  return query<QuestionSet>(sql, params);
};

// ── Get or create default question set for a role ─────────────
export const getOrCreateDefaultQuestionSet = async (
  tenantId: string,
  jobRole: JobRole,
  createdBy: string
): Promise<QuestionSet> => {
  const existing = await queryOne<QuestionSet>(
    `SELECT * FROM question_sets
     WHERE tenant_id = $1 AND job_role = $2 AND is_default = true`,
    [tenantId, jobRole]
  );
  if (existing) return existing;

  return createQuestionSet(tenantId, createdBy, {
    name: `Default ${jobRole.replace('_', ' ')} Questions`,
    job_role: jobRole,
    questions: DEFAULT_QUESTIONS[jobRole] ?? DEFAULT_QUESTIONS[JobRole.OTHER],
    is_default: true,
  });
};

// ── Update question set ───────────────────────────────────────
export const updateQuestionSet = async (
  id: string,
  tenantId: string,
  data: Partial<{ name: string; questions: Question[] }>
): Promise<QuestionSet> => {
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.name) { updates.push(`name = $${idx++}`); params.push(data.name); }
  if (data.questions) { updates.push(`questions = $${idx++}`); params.push(JSON.stringify(data.questions)); }

  if (!updates.length) throw new AppError('Nothing to update', 400);

  updates.push(`updated_at = NOW()`);
  params.push(id, tenantId);

  const result = await query<QuestionSet>(
    `UPDATE question_sets SET ${updates.join(', ')}
     WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
    params
  );
  if (!result[0]) throw new AppError('Question set not found', 404);
  return result[0];
};

// ── Delete question set ───────────────────────────────────────
export const deleteQuestionSet = async (id: string, tenantId: string): Promise<void> => {
  const result = await query(
    'DELETE FROM question_sets WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [id, tenantId]
  );
  if (!result[0]) throw new AppError('Question set not found', 404);
};
