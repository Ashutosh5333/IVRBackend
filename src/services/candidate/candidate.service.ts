import * as XLSX from 'xlsx';
import { query, queryOne, withTransaction } from '../../config/database';
import { AppError } from '../../middleware/error.middleware';
import { Candidate, CandidateStatus, JobRole, PaginationQuery } from '../../types';
import { logger } from '../../utils/logger';

interface ExcelRow {
  Name?: string;
  name?: string;
  Email?: string;
  email?: string;
  Phone?: string;
  phone?: string;
  'Job Role'?: string;
  'job_role'?: string;
  Role?: string;
}

// ── Parse Excel/CSV buffer → candidate rows ───────────────────
export const parseExcelCandidates = (
  buffer: Buffer,
  mimeType: string
): ExcelRow[] => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<ExcelRow>(sheet, { defval: '' });
  return rows;
};

// ── Normalize job role string ─────────────────────────────────
const normalizeJobRole = (raw: string): JobRole => {
  const lower = raw.toLowerCase().replace(/[_\s-]/g, '');
  if (lower.includes('software') || lower.includes('developer') || lower.includes('engineer')) {
    return JobRole.SOFTWARE_ENGINEER;
  }
  if (lower.includes('ar') || lower.includes('accountreceivable')) return JobRole.AR_CALLER;
  if (lower.includes('payment') || lower.includes('posting')) return JobRole.PAYMENT_POSTING;
  if (lower.includes('coder') || lower.includes('coding') || lower.includes('medicalcod')) {
    return JobRole.MEDICAL_CODER;
  }
  if (lower.includes('billing')) return JobRole.BILLING_SPECIALIST;
  if (lower.includes('operation')) return JobRole.OPERATIONS;
  if (lower.includes('support') || lower.includes('customer')) return JobRole.CUSTOMER_SUPPORT;
  return JobRole.OTHER;
};

// ── Bulk import candidates from Excel ─────────────────────────
export const importCandidatesFromExcel = async (
  buffer: Buffer,
  mimeType: string,
  tenantId: string,
  uploadedBy: string,
  campaignId?: string
): Promise<{ imported: number; skipped: number; errors: string[] }> => {
  const rows = parseExcelCandidates(buffer, mimeType);
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const name = (row.Name ?? row.name ?? '').toString().trim();
    const email = (row.Email ?? row.email ?? '').toString().trim().toLowerCase() || null;
    const phone = (row.Phone ?? row.phone ?? '').toString().trim().replace(/\s+/g, '');
    const roleRaw = (row['Job Role'] ?? row.job_role ?? row.Role ?? '').toString().trim();
    const jobRole = normalizeJobRole(roleRaw);

    if (!name || !phone) {
      errors.push(`Row skipped: missing name or phone (${JSON.stringify(row)})`);
      skipped++;
      continue;
    }

    if (!/^\+?[0-9]{7,15}$/.test(phone)) {
      errors.push(`Invalid phone for ${name}: ${phone}`);
      skipped++;
      continue;
    }

    try {
      await query(
        `INSERT INTO candidates
          (tenant_id, campaign_id, name, email, phone, job_role, status, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [tenantId, campaignId ?? null, name, email, phone, jobRole,
          CandidateStatus.PENDING, uploadedBy]
      );
      imported++;
    } catch (err) {
      logger.error('Candidate import row error', err);
      errors.push(`Failed to import ${name}`);
      skipped++;
    }
  }

  // Update campaign total if provided
  if (campaignId) {
    await query(
      'UPDATE campaigns SET total_candidates = total_candidates + $1 WHERE id = $2',
      [imported, campaignId]
    );
  }

  logger.info(`Excel import: ${imported} imported, ${skipped} skipped`);
  return { imported, skipped, errors };
};

// ── Get candidates with pagination & filters ──────────────────
export const getCandidates = async (
  tenantId: string,
  query_opts: PaginationQuery & {
    status?: CandidateStatus;
    job_role?: JobRole;
    campaign_id?: string;
  }
): Promise<{ candidates: Candidate[]; total: number }> => {
  const {
    page = 1, limit = 20, search, sort_by = 'created_at',
    sort_order = 'desc', status, job_role, campaign_id,
  } = query_opts;

  const offset = (page - 1) * limit;
  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let paramIdx = 2;

  if (status) {
    conditions.push(`c.status = $${paramIdx++}`);
    params.push(status);
  }
  if (job_role) {
    conditions.push(`c.job_role = $${paramIdx++}`);
    params.push(job_role);
  }
  if (campaign_id) {
    conditions.push(`c.campaign_id = $${paramIdx++}`);
    params.push(campaign_id);
  }
  if (search) {
    conditions.push(`(c.name ILIKE $${paramIdx} OR c.email ILIKE $${paramIdx} OR c.phone ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const where = conditions.join(' AND ');
  const safeSort = ['created_at', 'name', 'status', 'fit_score', 'last_called_at'].includes(sort_by)
    ? sort_by : 'created_at';
  const safeOrder = sort_order === 'asc' ? 'ASC' : 'DESC';

  const [candidates, countResult] = await Promise.all([
    query<Candidate>(
      `SELECT c.*, u.first_name || ' ' || u.last_name as uploaded_by_name
       FROM candidates c
       LEFT JOIN users u ON c.uploaded_by = u.id
       WHERE ${where}
       ORDER BY c.${safeSort} ${safeOrder}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM candidates c WHERE ${where}`,
      params
    ),
  ]);

  return {
    candidates,
    total: parseInt(countResult[0]?.count ?? '0', 10),
  };
};

// ── Get single candidate ──────────────────────────────────────
export const getCandidateById = async (
  id: string,
  tenantId: string
): Promise<Candidate> => {
  const candidate = await queryOne<Candidate>(
    `SELECT c.*, 
      (SELECT json_agg(cs.*) FROM call_sessions cs WHERE cs.candidate_id = c.id) as call_history
     FROM candidates c WHERE c.id = $1 AND c.tenant_id = $2`,
    [id, tenantId]
  );
  if (!candidate) throw new AppError('Candidate not found', 404);
  return candidate;
};

// ── Update candidate status ───────────────────────────────────
export const updateCandidateStatus = async (
  id: string,
  tenantId: string,
  status: CandidateStatus,
  notes?: string
): Promise<Candidate> => {
  const result = await query<Candidate>(
    `UPDATE candidates SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [status, notes ?? null, id, tenantId]
  );
  if (!result[0]) throw new AppError('Candidate not found', 404);
  return result[0];
};

// ── Schedule a callback ───────────────────────────────────────

// Inside your candidateService.scheduleCandidateCallback implementation:

export const scheduleCandidateCallback = async (
  candidateId: string,
  tenantId: string,
  scheduledAt: Date
) => {
  await query(
    `UPDATE candidates 
     SET status = 'pending', 
         scheduled_call_at = $1, 
         updated_at = NOW() 
     WHERE id = $2 AND tenant_id = $3`,
    [scheduledAt, candidateId, tenantId]
  );
};

// ── Delete candidate ──────────────────────────────────────────
export const deleteCandidate = async (id: string, tenantId: string): Promise<void> => {
  const result = await query(
    'DELETE FROM candidates WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [id, tenantId]
  );
  if (!result[0]) throw new AppError('Candidate not found', 404);
};
