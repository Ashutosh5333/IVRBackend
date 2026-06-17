import { query } from '../../config/database';

export interface DashboardStats {
  total_candidates: number;
  calls_today: number;
  selected_count: number;
  rejection_rate: number;
  avg_call_duration: number;
  pending_calls: number;
  interviews_scheduled: number;
  calls_by_status: Record<string, number>;
}

export interface CallReport {
  date: string;
  total_calls: number;
  completed: number;
  no_answer: number;
  selected: number;
  rejected: number;
}

// ── Dashboard overview stats ──────────────────────────────────
export const getDashboardStats = async (tenantId: string): Promise<DashboardStats> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalCandidates,
    callsToday,
    statusCounts,
    avgDuration,
    interviewsScheduled,
  ] = await Promise.all([
    query<{ count: string }>(
      'SELECT COUNT(*) as count FROM candidates WHERE tenant_id = $1',
      [tenantId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, today]
    ),
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM candidates
       WHERE tenant_id = $1 GROUP BY status`,
      [tenantId]
    ),
    query<{ avg: string }>(
      `SELECT AVG(duration_seconds) as avg FROM call_sessions
       WHERE tenant_id = $1 AND status = 'completed'`,
      [tenantId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM interviews
       WHERE tenant_id = $1 AND status = 'scheduled'`,
      [tenantId]
    ),
  ]);

  const statusMap: Record<string, number> = {};
  let selectedCount = 0;
  let rejectedCount = 0;
  let pendingCalls = 0;

  for (const row of statusCounts) {
    statusMap[row.status] = parseInt(row.count, 10);
    if (row.status === 'selected') selectedCount = parseInt(row.count, 10);
    if (row.status === 'rejected') rejectedCount = parseInt(row.count, 10);
    if (row.status === 'pending') pendingCalls = parseInt(row.count, 10);
  }

  const total = parseInt(totalCandidates[0]?.count ?? '0', 10);
  const processed = selectedCount + rejectedCount;
  const rejectionRate = processed > 0 ? Math.round((rejectedCount / processed) * 100) : 0;

  return {
    total_candidates: total,
    calls_today: parseInt(callsToday[0]?.count ?? '0', 10),
    selected_count: selectedCount,
    rejection_rate: rejectionRate,
    avg_call_duration: Math.round(parseFloat(avgDuration[0]?.avg ?? '0')),
    pending_calls: pendingCalls,
    interviews_scheduled: parseInt(interviewsScheduled[0]?.count ?? '0', 10),
    calls_by_status: statusMap,
  };
};

// ── Call trend report (last 30 days) ─────────────────────────
export const getCallTrendReport = async (
  tenantId: string,
  days: number = 30
): Promise<CallReport[]> => {
  const from = new Date();
  from.setDate(from.getDate() - days);

  const rows = await query<{
    date: string;
    total_calls: string;
    completed: string;
    no_answer: string;
  }>(
    `SELECT
       DATE(cs.created_at) as date,
       COUNT(*) as total_calls,
       COUNT(*) FILTER (WHERE cs.status = 'completed') as completed,
       COUNT(*) FILTER (WHERE cs.status = 'no_answer') as no_answer
     FROM call_sessions cs
     WHERE cs.tenant_id = $1 AND cs.created_at >= $2
     GROUP BY DATE(cs.created_at)
     ORDER BY date ASC`,
    [tenantId, from]
  );

  return rows.map((r) => ({
    date: r.date,
    total_calls: parseInt(r.total_calls, 10),
    completed: parseInt(r.completed, 10),
    no_answer: parseInt(r.no_answer, 10),
    selected: 0,
    rejected: 0,
  }));
};

// ── Candidate funnel report ───────────────────────────────────
export const getCandidateFunnelReport = async (
  tenantId: string,
  campaignId?: string
): Promise<Array<{ stage: string; count: number; percentage: number }>> => {
  const params: unknown[] = [tenantId];
  const campaignFilter = campaignId ? `AND campaign_id = $2` : '';
  if (campaignId) params.push(campaignId);

  const rows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM candidates
     WHERE tenant_id = $1 ${campaignFilter}
     GROUP BY status`,
    params
  );

  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);

  const stageOrder = ['pending', 'calling', 'call_done', 'no_answer',
    'rescheduled', 'selected', 'rejected', 'interview_scheduled'];

  return stageOrder.map((stage) => {
    const row = rows.find((r) => r.status === stage);
    const count = parseInt(row?.count ?? '0', 10);
    return {
      stage,
      count,
      percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });
};

// ── Role-wise hiring report ───────────────────────────────────
export const getRoleWiseReport = async (tenantId: string): Promise<Array<{
  job_role: string;
  total: number;
  selected: number;
  rejected: number;
  pending: number;
}>> => {
  const rows = await query<{
    job_role: string;
    total: string;
    selected: string;
    rejected: string;
    pending: string;
  }>(
    `SELECT
       job_role,
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'selected') as selected,
       COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
       COUNT(*) FILTER (WHERE status = 'pending') as pending
     FROM candidates
     WHERE tenant_id = $1
     GROUP BY job_role`,
    [tenantId]
  );

  return rows.map((r) => ({
    job_role: r.job_role,
    total: parseInt(r.total, 10),
    selected: parseInt(r.selected, 10),
    rejected: parseInt(r.rejected, 10),
    pending: parseInt(r.pending, 10),
  }));
};

// ── HR activity report ────────────────────────────────────────
export const getHrActivityReport = async (tenantId: string): Promise<Array<{
  hr_name: string;
  candidates_uploaded: number;
  calls_initiated: number;
  selected: number;
}>> => {
  return query(
    `SELECT
       u.first_name || ' ' || u.last_name as hr_name,
       COUNT(DISTINCT c.id) as candidates_uploaded,
       COUNT(DISTINCT cs.id) as calls_initiated,
       COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'selected') as selected
     FROM users u
     LEFT JOIN candidates c ON c.uploaded_by = u.id AND c.tenant_id = $1
     LEFT JOIN call_sessions cs ON cs.initiated_by = u.id AND cs.tenant_id = $1
     WHERE u.tenant_id = $1
     GROUP BY u.id, u.first_name, u.last_name
     ORDER BY calls_initiated DESC`,
    [tenantId]
  );
};
