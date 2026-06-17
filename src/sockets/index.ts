import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

let io: SocketServer;

export const initSocketServer = (httpServer: HttpServer): SocketServer => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware ────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
        userId: string;
        tenantId: string;
        role: string;
      };
      socket.data.userId = payload.userId;
      socket.data.tenantId = payload.tenantId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────
  io.on('connection', (socket) => {
    const { userId, tenantId } = socket.data as { userId: string; tenantId: string };
    logger.info(`Socket connected: ${userId} (tenant: ${tenantId})`);

    // Join tenant room - all events scoped to tenant
    socket.join(`tenant:${tenantId}`);
    // Join user room - personal notifications
    socket.join(`user:${userId}`);

    // ── HR joins a campaign room ─────────────────────────────
    socket.on('join:campaign', (campaignId: string) => {
      socket.join(`campaign:${campaignId}`);
    });

    socket.on('leave:campaign', (campaignId: string) => {
      socket.leave(`campaign:${campaignId}`);
    });

    // ── HR requests live call status ─────────────────────────
    socket.on('call:watch', async (callSessionId: string) => {
      socket.join(`call:${callSessionId}`);
    });

    socket.on('call:unwatch', (callSessionId: string) => {
      socket.leave(`call:${callSessionId}`);
    });

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${userId} (${reason})`);
    });

    socket.on('error', (err) => {
      logger.error(`Socket error for ${userId}:`, err);
    });
  });

  logger.info('✅ Socket.io server initialized');
  return io;
};

export const getSocketServer = (): SocketServer => {
  if (!io) throw new Error('Socket server not initialized');
  return io;
};

// ── Emit helpers ──────────────────────────────────────────────

export const emitToTenant = (tenantId: string, event: string, data: unknown): void => {
  io?.to(`tenant:${tenantId}`).emit(event, data);
};

export const emitToUser = (userId: string, event: string, data: unknown): void => {
  io?.to(`user:${userId}`).emit(event, data);
};

export const emitCallUpdate = (
  tenantId: string,
  callSessionId: string,
  event: string,
  data: unknown
): void => {
  io?.to(`tenant:${tenantId}`).emit(event, data);
  io?.to(`call:${callSessionId}`).emit(event, data);
};
