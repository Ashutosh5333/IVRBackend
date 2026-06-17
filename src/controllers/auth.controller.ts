import { Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import * as authService from '../services/auth/auth.service';
import { sendSuccess, sendCreated, sendError } from '../utils/response';

// ── Validation rules ──────────────────────────────────────────
export const registerValidation = [
  body('company_name').trim().notEmpty().withMessage('Company name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password min 8 characters'),
  body('first_name').trim().notEmpty().withMessage('First name required'),
  body('last_name').trim().notEmpty().withMessage('Last name required'),
];

export const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

// ── Register ──────────────────────────────────────────────────
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, 'Validation failed', 400,
        errors.array().map((e) => ({ field: (e as { path: string }).path, message: e.msg }))
      );
      return;
    }

    const { tenant, user, tokens } = await authService.registerTenant(req.body);

    // Set refresh token as httpOnly cookie
    res.cookie('refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    sendCreated(res, {
      access_token: tokens.access_token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        trial_ends_at: tenant.trial_ends_at,
      },
    }, 'Account created successfully');
  } catch (error) {
    next(error);
  }
};

// ── Login ─────────────────────────────────────────────────────
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, 'Invalid credentials', 400);
      return;
    }

    const { email, password } = req.body as { email: string; password: string };
    const { user, tenant, tokens } = await authService.loginWithPassword(email, password);

    res.cookie('refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    sendSuccess(res, {
      access_token: tokens.access_token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        tenant_id: user.tenant_id,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        subscription_status: tenant.subscription_status,
        trial_ends_at: tenant.trial_ends_at,
        max_concurrent_calls: tenant.max_concurrent_calls,
      },
    }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

// ── Google / Firebase login ───────────────────────────────────
export const googleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id_token } = req.body as { id_token: string };
    if (!id_token) { sendError(res, 'Firebase ID token required', 400); return; }

    const { user, tenant, tokens } = await authService.loginWithFirebase(id_token);

    res.cookie('refresh_token', tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    sendSuccess(res, {
      access_token: tokens.access_token,
      user: { id: user.id, email: user.email, first_name: user.first_name,
        last_name: user.last_name, role: user.role },
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
    });
  } catch (error) {
    next(error);
  }
};

// ── Refresh ───────────────────────────────────────────────────
export const refresh = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (!refreshToken) { sendError(res, 'Refresh token not found', 401); return; }

    const { access_token } = await authService.refreshAccessToken(refreshToken);
    sendSuccess(res, { access_token });
  } catch (error) {
    next(error);
  }
};

// ── Logout ────────────────────────────────────────────────────
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (req.user && token) {
      await authService.logout(req.user.id, token);
    }
    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    sendSuccess(res, null, 'Logged out successfully');
  } catch (error) {
    next(error);
  }
};

// ── Get current user ──────────────────────────────────────────
export const me = async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, { user: req.user });
};

// ── Invite user ───────────────────────────────────────────────
export const invite = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    const user = await authService.inviteUser({
      ...req.body as { email: string; first_name: string; last_name: string; role: string },
      tenant_id: req.user.tenant_id,
      invited_by: req.user.id,
    } as Parameters<typeof authService.inviteUser>[0]);
    sendCreated(res, user, 'User invited successfully');
  } catch (error) {
    next(error);
  }
};
