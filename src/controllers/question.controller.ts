import { Request, Response, NextFunction } from 'express';
import * as questionService from '../services/question/question.service';
import * as scheduleService from '../services/schedule/schedule.service';
import * as reportService from '../services/report/report.service';
import { sendSuccess, sendCreated, sendError } from '../utils/response';
import { JobRole, InterviewStatus } from '../types';

// ─────────────────────────────────────────────────────────────
// QUESTION SET CONTROLLERS
// ─────────────────────────────────────────────────────────────

export const createQuestionSet = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const qs = await questionService.createQuestionSet(req.user.tenant_id, req.user.id, req.body);
    sendCreated(res, qs, 'Question set created');
  } catch (error) { next(error); }
};

export const listQuestionSets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { job_role } = req.query as { job_role?: JobRole };
    const sets = await questionService.getQuestionSets(req.user.tenant_id, job_role);
    sendSuccess(res, sets);
  } catch (error) { next(error); }
};

export const updateQuestionSet = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const qs = await questionService.updateQuestionSet(req.params.id, req.user.tenant_id, req.body);
    sendSuccess(res, qs, 'Question set updated');
  } catch (error) { next(error); }
};

export const deleteQuestionSet = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    await questionService.deleteQuestionSet(req.params.id, req.user.tenant_id);
    sendSuccess(res, null, 'Question set deleted');
  } catch (error) { next(error); }
};

export const getDefaultQuestions = async (req: Request, res: Response): Promise<void> => {
  const { job_role } = req.params as { job_role: JobRole };
  const questions = questionService.DEFAULT_QUESTIONS[job_role] ?? questionService.DEFAULT_QUESTIONS[JobRole.OTHER];
  sendSuccess(res, questions);
};

// ─────────────────────────────────────────────────────────────
// INTERVIEW CONTROLLERS
// ─────────────────────────────────────────────────────────────

export const scheduleInterview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const body = req.body as {
      candidate_id: string;
      call_session_id?: string;
      panel_member_ids: string[];
      scheduled_at: string;
      duration_minutes?: number;
      meeting_link?: string;
      location?: string;
    };
    const interview = await scheduleService.scheduleInterview({
      ...body,
      tenant_id: req.user.tenant_id,
      created_by: req.user.id,
      scheduled_at: new Date(body.scheduled_at),
    });
    sendCreated(res, interview, 'Interview scheduled');
  } catch (error) { next(error); }
};

export const listInterviews = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { status, from, to, candidate_id } = req.query as Record<string, string>;
    const interviews = await scheduleService.getInterviews(req.user.tenant_id, {
      status: status as InterviewStatus,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      candidate_id,
    });
    sendSuccess(res, interviews);
  } catch (error) { next(error); }
};

export const getPanelSlots = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { job_role, from, to } = req.query as Record<string, string>;
    if (!from || !to) { sendError(res, 'from and to dates required', 400); return; }
    const slots = await scheduleService.getAvailablePanelSlots(
      req.user.tenant_id, job_role, new Date(from), new Date(to)
    );
    sendSuccess(res, slots);
  } catch (error) { next(error); }
};

export const updateInterviewStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { status, notes } = req.body as { status: InterviewStatus; notes?: string };
    const interview = await scheduleService.updateInterviewStatus(req.params.id, req.user.tenant_id, status, notes);
    sendSuccess(res, interview, 'Interview updated');
  } catch (error) { next(error); }
};

// ─────────────────────────────────────────────────────────────
// REPORT CONTROLLERS
// ─────────────────────────────────────────────────────────────

export const getDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const stats = await reportService.getDashboardStats(req.user.tenant_id);
    sendSuccess(res, stats);
  } catch (error) { next(error); }
};

export const getCallTrend = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const days = parseInt((req.query.days as string) ?? '30');
    const data = await reportService.getCallTrendReport(req.user.tenant_id, days);
    sendSuccess(res, data);
  } catch (error) { next(error); }
};

export const getCandidateFunnel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { campaign_id } = req.query as { campaign_id?: string };
    const data = await reportService.getCandidateFunnelReport(req.user.tenant_id, campaign_id);
    sendSuccess(res, data);
  } catch (error) { next(error); }
};

export const getRoleWise = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const data = await reportService.getRoleWiseReport(req.user.tenant_id);
    sendSuccess(res, data);
  } catch (error) { next(error); }
};

export const getHrActivity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const data = await reportService.getHrActivityReport(req.user.tenant_id);
    sendSuccess(res, data);
  } catch (error) { next(error); }
};
