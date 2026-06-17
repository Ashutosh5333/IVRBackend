import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { logger } from '../utils/logger';

export const auditLog = (action: string, entityType: string) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.user) {
        await query(
          `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_value, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.user.tenant_id,
            req.user.id,
            action,
            entityType,
            req.params.id ?? null,
            req.body ? JSON.stringify(req.body) : null,
            req.ip,
            req.headers['user-agent'] ?? null,
          ]
        );
      }
    } catch (err) {
      logger.error('Audit log failed', err);
    }
    next();
  };
};
