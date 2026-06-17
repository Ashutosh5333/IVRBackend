import { Request, Response, NextFunction } from 'express';
import * as candidateService from '../services/candidate/candidate.service';
import * as resumeService from '../services/resume/resume.service';
import { addResumeJob } from '../queues';
import { sendSuccess, sendCreated, sendError, paginate } from '../utils/response';
import { CandidateStatus, JobRole } from '../types';

// ── Upload Excel and bulk import ──────────────────────────────
export const uploadExcel = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file) { sendError(res, 'No file uploaded', 400); return; }
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const { campaign_id } = req.query as { campaign_id?: string };

    const result = await candidateService.importCandidatesFromExcel(
      req.file.buffer,
      req.file.mimetype,
      req.user.tenant_id,
      req.user.id,
      campaign_id
    );

    sendSuccess(res, result, `Imported ${result.imported} candidates`);
  } catch (error) {
    next(error);
  }
};

// ── Upload single resume ──────────────────────────────────────
export const uploadResume = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file || !req.user) { sendError(res, 'File and auth required', 400); return; }

    const { candidate_id } = req.params;
    const job_role = req.body.job_role as JobRole;

    // Extract text immediately (fast)
    const rawText = await resumeService.extractResumeText(req.file.buffer, req.file.mimetype);

    // Queue AI parsing (async)
    await addResumeJob({
      candidate_id,
      tenant_id: req.user.tenant_id,
      resume_url: rawText, // Pass raw text as URL placeholder
      job_role,
    });

    sendSuccess(res, { message: 'Resume uploaded, parsing in progress' });
  } catch (error) {
    next(error);
  }
};

// ── List candidates ───────────────────────────────────────────
export const listCandidates = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }

    const {
      page = '1', limit = '20', search, status, job_role, campaign_id,
      sort_by, sort_order,
    } = req.query as Record<string, string>;

    const { candidates, total } = await candidateService.getCandidates(
      req.user.tenant_id,
      {
        page: parseInt(page),
        limit: Math.min(parseInt(limit), 100),
        search,
        status: status as CandidateStatus,
        job_role: job_role as JobRole,
        campaign_id,
        sort_by,
        sort_order: sort_order as 'asc' | 'desc',
      }
    );

    paginate(res, candidates, total, parseInt(page), parseInt(limit));
  } catch (error) {
    next(error);
  }
};

// ── Get single candidate ──────────────────────────────────────
export const getCandidate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const candidate = await candidateService.getCandidateById(req.params.id, req.user.tenant_id);
    sendSuccess(res, candidate);
  } catch (error) {
    next(error);
  }
};

// ── Update candidate status ───────────────────────────────────
export const updateStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { status, notes } = req.body as { status: CandidateStatus; notes?: string };
    const candidate = await candidateService.updateCandidateStatus(
      req.params.id, req.user.tenant_id, status, notes
    );
    sendSuccess(res, candidate, 'Status updated');
  } catch (error) {
    next(error);
  }
};

// ── Schedule callback ─────────────────────────────────────────
export const scheduleCallback = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const { scheduled_at } = req.body as { scheduled_at: string };
    await candidateService.scheduleCandidateCallback(
      req.params.id,
      req.user.tenant_id,
      new Date(scheduled_at)
    );
    sendSuccess(res, null, 'Callback scheduled');
  } catch (error) {
    next(error);
  }
};

// ── Delete candidate ──────────────────────────────────────────
export const deleteCandidate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    await candidateService.deleteCandidate(req.params.id, req.user.tenant_id);
    sendSuccess(res, null, 'Candidate deleted');
  } catch (error) {
    next(error);
  }
};
