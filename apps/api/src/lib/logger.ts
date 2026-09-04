import pino from 'pino';
import { env } from '../config/env.js';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'credentials',
  '*.credentials',
  'refreshToken',
  '*.refreshToken',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'datasynx-api' },
});

export type Logger = typeof logger;
