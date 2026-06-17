import { query, queryOne } from '../../config/database';
import { AppError } from '../../middleware/error.middleware';
import { Interview, InterviewStatus, CandidateStatus } from '../../types';
import { addEmailJob } from '../../queues';
import { logger } from '../../utils/logger';

// ── Get available panel slots ─────────────────────────────────
export const getAvailablePanelSlots = async (
  tenantId: string,
  jobRole: string,
  fromDate: Date,
  toDate: Date
): Promise<Array<{ panel_member_id: string; name: string; available_slots: Date[] }>> => {
  const panels = await query<{
    id: string; name: string; email: string;
  }>(
    `SELECT id, name, email FROM panel_members
     WHERE tenant_id = $1 AND is_available = true
     AND job_roles @> $2::jsonb`,
    [tenantId, JSON.stringify([jobRole])]
  );

  const slots: Array<{ panel_member_id: string; name: string; available_slots: Date[] }> = [];

  for (const panel of panels) {
    // Get booked slots for this panel member
    const booked = await query<{ scheduled_at: Date }>(
      `SELECT scheduled_at FROM interviews
       WHERE tenant_id = $1 AND panel_member_ids @> $2::jsonb
       AND scheduled_at BETWEEN $3 AND $4
       AND status NOT IN ('cancelled')`,
      [tenantId, JSON.stringify([panel.id]), fromDate, toDate]
    );

    const bookedTimes = new Set(booked.map((b) => new Date(b.scheduled_at).getTime()));

    // Generate 9am-5pm slots (1 hour each) for each working day
    const available: Date[] = [];
    const current = new Date(fromDate);

    while (current <= toDate) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) { // Skip weekends
        for (let hour = 9; hour <= 16; hour++) {
          const slot = new Date(current);
          slot.setHours(hour, 0, 0, 0);
          if (!bookedTimes.has(slot.getTime()) && slot > new Date()) {
            available.push(new Date(slot));
          }
        }
      }
      current.setDate(current.getDate() + 1);
    }

    slots.push({ panel_member_id: panel.id, name: panel.name, available_slots: available });
  }

  return slots;
};

// ── Schedule interview ────────────────────────────────────────
export const scheduleInterview = async (data: {
  tenant_id: string;
  candidate_id: string;
  call_session_id?: string;
  panel_member_ids: string[];
  scheduled_at: Date;
  duration_minutes?: number;
  meeting_link?: string;
  location?: string;
  created_by: string;
}): Promise<Interview> => {
  // Check slot not already taken by any panel member
  for (const panelId of data.panel_member_ids) {
    const conflict = await queryOne(
      `SELECT id FROM interviews
       WHERE tenant_id = $1
       AND panel_member_ids @> $2::jsonb
       AND scheduled_at = $3
       AND status NOT IN ('cancelled')`,
      [data.tenant_id, JSON.stringify([panelId]), data.scheduled_at]
    );
    if (conflict) {
      throw new AppError(`Panel member ${panelId} is already booked at this time`, 409);
    }
  }

  const result = await query<Interview>(
    `INSERT INTO interviews
      (tenant_id, candidate_id, call_session_id, panel_member_ids,
       scheduled_at, duration_minutes, meeting_link, location, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.tenant_id,
      data.candidate_id,
      data.call_session_id ?? null,
      JSON.stringify(data.panel_member_ids),
      data.scheduled_at,
      data.duration_minutes ?? 45,
      data.meeting_link ?? null,
      data.location ?? null,
      data.created_by,
    ]
  );
  const interview = result[0];

  // Update candidate status
  await query(
    'UPDATE candidates SET status = $1 WHERE id = $2 AND tenant_id = $3',
    [CandidateStatus.INTERVIEW_SCHEDULED, data.candidate_id, data.tenant_id]
  );

  // Send email notification
  const candidate = await queryOne<{ name: string; email: string }>(
    'SELECT name, email FROM candidates WHERE id = $1',
    [data.candidate_id]
  );
  const tenant = await queryOne<{ name: string }>(
    'SELECT name FROM tenants WHERE id = $1',
    [data.tenant_id]
  );

  if (candidate?.email && tenant) {
    await addEmailJob({
      type: 'interview_scheduled',
      to: candidate.email,
      candidate_name: candidate.name,
      tenant_name: tenant.name,
      interview_details: {
        date: data.scheduled_at.toLocaleDateString('en-IN'),
        time: data.scheduled_at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        location: data.location,
        meeting_link: data.meeting_link,
      },
    });
  }

  logger.info(`Interview scheduled: ${interview.id} for candidate ${data.candidate_id}`);
  return interview;
};

// ── Get interviews for tenant ─────────────────────────────────
export const getInterviews = async (
  tenantId: string,
  filters: { status?: InterviewStatus; from?: Date; to?: Date; candidate_id?: string }
): Promise<Interview[]> => {
  const conditions = ['i.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (filters.status) { conditions.push(`i.status = $${idx++}`); params.push(filters.status); }
  if (filters.from) { conditions.push(`i.scheduled_at >= $${idx++}`); params.push(filters.from); }
  if (filters.to) { conditions.push(`i.scheduled_at <= $${idx++}`); params.push(filters.to); }
  if (filters.candidate_id) { conditions.push(`i.candidate_id = $${idx++}`); params.push(filters.candidate_id); }

  return query<Interview>(
    `SELECT i.*, c.name as candidate_name, c.phone as candidate_phone,
       c.job_role
     FROM interviews i
     JOIN candidates c ON i.candidate_id = c.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY i.scheduled_at ASC`,
    params
  );
};

// ── Update interview status ───────────────────────────────────
export const updateInterviewStatus = async (
  id: string,
  tenantId: string,
  status: InterviewStatus,
  notes?: string
): Promise<Interview> => {
  const result = await query<Interview>(
    `UPDATE interviews SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [status, notes ?? null, id, tenantId]
  );
  if (!result[0]) throw new AppError('Interview not found', 404);
  return result[0];
};
