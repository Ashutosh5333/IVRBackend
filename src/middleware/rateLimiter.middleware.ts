import rateLimit from 'express-rate-limit';
import { sendError } from '../utils/response';

// ── General API rate limit ────────────────────────────────────
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(res, 'Too many requests, please try again later', 429);
  },
});

// ── Auth endpoints - stricter limit ──────────────────────────
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (_req, res) => {
    sendError(res, 'Too many login attempts, please try again after 15 minutes', 429);
  },
});

// ── Call trigger - prevent accidental mass calls ──────────────
export const callLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  handler: (_req, res) => {
    sendError(res, 'Too many call requests per minute', 429);
  },
});

// ── File upload limiter ───────────────────────────────────────
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  handler: (_req, res) => {
    sendError(res, 'Upload limit reached, try again later', 429);
  },
});
