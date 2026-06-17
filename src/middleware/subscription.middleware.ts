import { Request, Response, NextFunction } from 'express';
import { queryOne } from '../config/database';
import { countActiveCalls } from '../config/redis';
import { sendError, sendForbidden } from '../utils/response';
import { Tenant, SubscriptionStatus } from '../types';

// ── Check subscription is active ─────────────────────────────
export const requireActiveSubscription = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendForbidden(res); return; }

    const tenant = await queryOne<Tenant>(
      'SELECT * FROM tenants WHERE id = $1 AND is_active = true',
      [req.user.tenant_id]
    );

    if (!tenant) {
      sendForbidden(res, 'Tenant not found or inactive');
      return;
    }

    const now = new Date();

    // Trial check
    if (tenant.plan === 'trial' && tenant.trial_ends_at) {
      if (new Date(tenant.trial_ends_at) < now) {
        sendError(res, 'Trial period expired. Please subscribe to continue.', 402);
        return;
      }
    }

    // Paid subscription check
    if (tenant.plan !== 'trial') {
      if (
        tenant.subscription_status !== SubscriptionStatus.ACTIVE ||
        (tenant.subscription_ends_at && new Date(tenant.subscription_ends_at) < now)
      ) {
        sendError(res, 'Subscription expired. Please renew to continue.', 402);
        return;
      }
    }

    // Attach tenant to request for downstream use
    (req as Request & { tenant: Tenant }).tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
};

// ── Check concurrent call limit before starting calls ────────
export const checkConcurrentCallLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendForbidden(res); return; }

    const tenant = await queryOne<Tenant>(
      'SELECT max_concurrent_calls FROM tenants WHERE id = $1',
      [req.user.tenant_id]
    );

    if (!tenant) { sendForbidden(res); return; }

    const activeCalls = await countActiveCalls(req.user.tenant_id);

    if (activeCalls >= tenant.max_concurrent_calls) {
      sendError(
        res,
        `Concurrent call limit reached (${tenant.max_concurrent_calls}). Wait for active calls to complete.`,
        429
      );
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};

// ── Check monthly candidate limit ────────────────────────────
export const checkMonthlyLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendForbidden(res); return; }

    const tenant = await queryOne<Tenant>(
      'SELECT max_candidates_per_month FROM tenants WHERE id = $1',
      [req.user.tenant_id]
    );
    if (!tenant) { sendForbidden(res); return; }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const result = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM candidates
       WHERE tenant_id = $1 AND created_at >= $2`,
      [req.user.tenant_id, startOfMonth]
    );

    const currentCount = parseInt(result?.count ?? '0', 10);

    if (currentCount >= tenant.max_candidates_per_month) {
      sendError(
        res,
        `Monthly candidate limit reached (${tenant.max_candidates_per_month}). Upgrade your plan.`,
        402
      );
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};
