import { Router } from 'express';
import { authenticate, hrOrAbove, tenantAdminOrAbove, superAdminOnly } from '../middleware/auth.middleware';
import { authLimiter, callLimiter, uploadLimiter } from '../middleware/rateLimiter.middleware';
import { requireActiveSubscription, checkConcurrentCallLimit, checkMonthlyLimit } from '../middleware/subscription.middleware';
import { uploadExcel as uploadExcelMiddleware, uploadResume as uploadResumeMiddleware } from '../middleware/upload.middleware';
import { auditLog } from '../middleware/audit.middleware';

// Controllers
import * as authCtrl from '../controllers/auth.controller';
import * as candidateCtrl from '../controllers/candidate.controller';
import * as callCtrl from '../controllers/call.controller';
import * as questionCtrl from '../controllers/question.controller';

const router = Router();

// ─────────────────────────────────────────────────────────────
// AUTH ROUTES  /api/auth/*
// ─────────────────────────────────────────────────────────────
const authRouter = Router();

authRouter.post('/register', authLimiter, authCtrl.registerValidation, authCtrl.register);
authRouter.post('/login', authLimiter, authCtrl.loginValidation, authCtrl.login);
authRouter.post('/google', authLimiter, authCtrl.googleLogin);
authRouter.post('/refresh', authCtrl.refresh);
authRouter.post('/logout', authenticate, authCtrl.logout);
authRouter.get('/me', authenticate, authCtrl.me);
authRouter.post('/invite', authenticate, tenantAdminOrAbove, auditLog('INVITE_USER', 'user'), authCtrl.invite);

router.use('/auth', authRouter);

// ─────────────────────────────────────────────────────────────
// CANDIDATE ROUTES  /api/candidates/*
// ─────────────────────────────────────────────────────────────
const candidateRouter = Router();

candidateRouter.use(authenticate, requireActiveSubscription);

candidateRouter.get('/', candidateCtrl.listCandidates);
candidateRouter.get('/:id', candidateCtrl.getCandidate);

candidateRouter.post(
  '/upload-excel',
  uploadLimiter,
  hrOrAbove,
  checkMonthlyLimit,
  uploadExcelMiddleware,
  auditLog('UPLOAD_EXCEL', 'candidate'),
  candidateCtrl.uploadExcel
);

candidateRouter.post(
  '/:id/resume',
  hrOrAbove,
  uploadResumeMiddleware,
  candidateCtrl.uploadResume
);

candidateRouter.patch(
  '/:id/status',
  hrOrAbove,
  auditLog('UPDATE_CANDIDATE_STATUS', 'candidate'),
  candidateCtrl.updateStatus
);

candidateRouter.post(
  '/:id/schedule-callback',
  hrOrAbove,
  candidateCtrl.scheduleCallback
);

candidateRouter.delete(
  '/:id',
  hrOrAbove,
  auditLog('DELETE_CANDIDATE', 'candidate'),
  candidateCtrl.deleteCandidate
);

router.use('/candidates', candidateRouter);

// ─────────────────────────────────────────────────────────────
// CALL ROUTES  /api/calls/*
// ─────────────────────────────────────────────────────────────
const callRouter = Router();

// Twilio webhook routes (no auth - public)
callRouter.post('/webhook/connect/:sessionId', callCtrl.webhookConnect);
callRouter.post('/webhook/answer/:sessionId/:questionIndex', callCtrl.webhookAnswer);
callRouter.post('/webhook/status/:sessionId', callCtrl.webhookStatus);
callRouter.post('/webhook/recording/:sessionId', callCtrl.webhookRecording);

// Protected call routes
callRouter.use(authenticate, requireActiveSubscription);

callRouter.get('/', callCtrl.getCallSessions);
callRouter.get('/:id', callCtrl.getCallSession);

callRouter.post(
  '/initiate',
  hrOrAbove,
  callLimiter,
  checkConcurrentCallLimit,
  auditLog('INITIATE_CALL', 'call_session'),
  callCtrl.initiateCall
);

callRouter.post(
  '/bulk-start',
  hrOrAbove,
  callLimiter,
  auditLog('BULK_CALL_START', 'call_session'),
  callCtrl.startBulkCalls
);

callRouter.get('/:id/recording', authenticate, callCtrl.proxyRecording);

router.use('/calls', callRouter);

// ─────────────────────────────────────────────────────────────
// QUESTION ROUTES  /api/questions/*
// ─────────────────────────────────────────────────────────────
const questionRouter = Router();

questionRouter.use(authenticate, requireActiveSubscription);

questionRouter.get('/', questionCtrl.listQuestionSets);
questionRouter.get('/defaults/:job_role', questionCtrl.getDefaultQuestions);
questionRouter.post('/', hrOrAbove, questionCtrl.createQuestionSet);
questionRouter.put('/:id', hrOrAbove, questionCtrl.updateQuestionSet);
questionRouter.delete('/:id', hrOrAbove, questionCtrl.deleteQuestionSet);

router.use('/questions', questionRouter);

// ─────────────────────────────────────────────────────────────
// INTERVIEW ROUTES  /api/interviews/*
// ─────────────────────────────────────────────────────────────
const interviewRouter = Router();

interviewRouter.use(authenticate, requireActiveSubscription);

interviewRouter.get('/', questionCtrl.listInterviews);
interviewRouter.get('/panel-slots', questionCtrl.getPanelSlots);
interviewRouter.post('/', hrOrAbove, auditLog('SCHEDULE_INTERVIEW', 'interview'), questionCtrl.scheduleInterview);
interviewRouter.patch('/:id/status', hrOrAbove, questionCtrl.updateInterviewStatus);

router.use('/interviews', interviewRouter);

// ─────────────────────────────────────────────────────────────
// REPORT ROUTES  /api/reports/*
// ─────────────────────────────────────────────────────────────
const reportRouter = Router();

reportRouter.use(authenticate, requireActiveSubscription);

reportRouter.get('/dashboard', questionCtrl.getDashboard);
reportRouter.get('/call-trend', questionCtrl.getCallTrend);
reportRouter.get('/funnel', questionCtrl.getCandidateFunnel);
reportRouter.get('/role-wise', questionCtrl.getRoleWise);
reportRouter.get('/hr-activity', questionCtrl.getHrActivity);

router.use('/reports', reportRouter);

// ─────────────────────────────────────────────────────────────
// TENANT/PROFILE ROUTES  /api/tenant/*
// ─────────────────────────────────────────────────────────────
const tenantRouter = Router();

tenantRouter.use(authenticate);

tenantRouter.get('/profile', async (req, res, next) => {
  try {
    const { queryOne } = await import('../config/database');
    const tenant = await queryOne(
      'SELECT id, name, slug, email, phone, logo_url, industry, plan, subscription_status, trial_ends_at, max_concurrent_calls, max_candidates_per_month FROM tenants WHERE id = $1',
      [req.user!.tenant_id]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, tenant);
  } catch (error) { next(error); }
});

tenantRouter.get('/users', tenantAdminOrAbove, async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const users = await query(
      `SELECT id, email, first_name, last_name, role, is_active, last_login, created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.user!.tenant_id]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, users);
  } catch (error) { next(error); }
});

tenantRouter.get('/audit-logs', tenantAdminOrAbove, async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const logs = await query(
      `SELECT al.*, u.first_name || ' ' || u.last_name as user_name
       FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id
       WHERE al.tenant_id = $1
       ORDER BY al.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user!.tenant_id, parseInt(limit), offset]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, logs);
  } catch (error) { next(error); }
});

// Panel members CRUD
tenantRouter.get('/panel-members', async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const members = await query(
      'SELECT * FROM panel_members WHERE tenant_id = $1 ORDER BY name',
      [req.user!.tenant_id]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, members);
  } catch (error) { next(error); }
});

tenantRouter.post('/panel-members', hrOrAbove, async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const { name, email, job_roles } = req.body as { name: string; email: string; job_roles: string[] };
    const result = await query(
      'INSERT INTO panel_members (tenant_id, name, email, job_roles) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user!.tenant_id, name, email, JSON.stringify(job_roles)]
    );
    const { sendCreated } = await import('../utils/response');
    sendCreated(res, result[0], 'Panel member added');
  } catch (error) { next(error); }
});

tenantRouter.delete('/panel-members/:id', hrOrAbove, async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    await query('DELETE FROM panel_members WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user!.tenant_id]);
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, null, 'Panel member removed');
  } catch (error) { next(error); }
});

router.use('/tenant', tenantRouter);

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES  /api/admin/*  (super admin only)
// ─────────────────────────────────────────────────────────────
const adminRouter = Router();

adminRouter.use(authenticate, superAdminOnly);

adminRouter.get('/tenants', async (_req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const tenants = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) as user_count,
       (SELECT COUNT(*) FROM candidates c WHERE c.tenant_id = t.id) as candidate_count
       FROM tenants t ORDER BY t.created_at DESC`
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, tenants);
  } catch (error) { next(error); }
});

adminRouter.patch('/tenants/:id/plan', async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const { plan, max_concurrent_calls, max_candidates_per_month, subscription_ends_at } =
      req.body as Record<string, string | number>;
    const result = await query(
      `UPDATE tenants SET plan = $1, max_concurrent_calls = $2,
       max_candidates_per_month = $3, subscription_ends_at = $4, subscription_status = 'active'
       WHERE id = $5 RETURNING *`,
      [plan, max_concurrent_calls, max_candidates_per_month, subscription_ends_at, req.params.id]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, result[0], 'Plan updated');
  } catch (error) { next(error); }
});

adminRouter.patch('/tenants/:id/toggle', async (req, res, next) => {
  try {
    const { query } = await import('../config/database');
    const result = await query(
      'UPDATE tenants SET is_active = NOT is_active WHERE id = $1 RETURNING id, is_active',
      [req.params.id]
    );
    const { sendSuccess } = await import('../utils/response');
    sendSuccess(res, result[0], 'Tenant status toggled');
  } catch (error) { next(error); }
});

router.use('/admin', adminRouter);

// Health check
router.get('/health', async (_req, res) => {
  const { checkDbConnection } = await import('../config/database');
  const dbOk = await checkDbConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: { database: dbOk ? 'up' : 'down' },
  });
});

export default router;
