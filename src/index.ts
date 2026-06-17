import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

import { logger, httpLogStream } from './utils/logger';
import { apiLimiter } from './middleware/rateLimiter.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { initSocketServer } from './sockets';
import { startWorkers } from './queues';
import { runMigrations } from './config/migrate';
import routes from './routes';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const app = express();
const httpServer = http.createServer(app);

// ── Security middleware ───────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── General middleware ────────────────────────────────────────
app.use(morgan('combined', { stream: httpLogStream }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use('/api', apiLimiter);

// ── Routes ────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 & Error handlers ──────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '5000', 10);

const start = async (): Promise<void> => {
  try {
    // Run DB migrations
    await runMigrations();
    logger.info('✅ Database ready');

    // Init Socket.io
    initSocketServer(httpServer);
    logger.info('✅ Socket.io ready');

    // Start BullMQ workers
    startWorkers();

    // Start HTTP server
    httpServer.listen(PORT, () => {
      logger.info(`🚀 VeloHR API running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received - shutting down gracefully');
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

start();

export { app, httpServer };
