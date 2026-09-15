import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { importRouter } from './modules/imports/routes.js';
import { processingRouter } from './modules/processing/routes.js';
import { exportRouter } from './modules/exports/routes.js';
import { emailRouter } from './modules/email/routes.js';
import { trainingRouter } from './modules/training/routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(
    cors({
      origin: env.WEB_PUBLIC_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger }));

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', mode: env.DATASYNX_MODE });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/imports', importRouter);
  app.use('/api/processing', processingRouter);
  app.use('/api/exports', exportRouter);
  app.use('/api/email', emailRouter);
  app.use('/api/training', trainingRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
