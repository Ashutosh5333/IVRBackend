import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '../types';
import { sendUnauthorized, sendForbidden } from '../utils/response';
import { cacheGet } from '../config/redis';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        tenant_id: string;
        role: UserRole;
        email: string;
      };
    }
  }
}

interface JwtPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

// ── Verify JWT access token ───────────────────────────────────
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendUnauthorized(res, 'No token provided');
      return;
    }

    const token = authHeader.split(' ')[1];

    // Check if token is blacklisted (on logout)
    const isBlacklisted = await cacheGet<boolean>(`blacklist:${token}`);
    if (isBlacklisted) {
      sendUnauthorized(res, 'Token has been revoked');
      return;
    }

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as JwtPayload;

    req.user = {
      id: payload.userId,
      tenant_id: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      sendUnauthorized(res, 'Token expired');
    } else {
      sendUnauthorized(res, 'Invalid token');
    }
  }
};

// ── Role-based access control ─────────────────────────────────
export const authorize = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendUnauthorized(res);
      return;
    }

    if (!roles.includes(req.user.role)) {
      sendForbidden(res, 'Insufficient permissions');
      return;
    }

    next();
  };
};

// ── Super admin only ──────────────────────────────────────────
export const superAdminOnly = authorize(UserRole.SUPER_ADMIN);

// ── Tenant admin or above ─────────────────────────────────────
export const tenantAdminOrAbove = authorize(
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_OWNER,
  UserRole.TENANT_ADMIN
);

// ── HR or above ───────────────────────────────────────────────
export const hrOrAbove = authorize(
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_OWNER,
  UserRole.TENANT_ADMIN,
  UserRole.HR_MANAGER
);

// ── Ensure same tenant (prevent cross-tenant data access) ─────
export const requireSameTenant = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const paramTenantId = req.params.tenantId || req.body.tenant_id;

  if (
    paramTenantId &&
    req.user?.role !== UserRole.SUPER_ADMIN &&
    req.user?.tenant_id !== paramTenantId
  ) {
    sendForbidden(res, 'Access denied to this tenant');
    return;
  }

  next();
};
