import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const disabled = env.NODE_ENV === 'test';

const make = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit: disabled ? 0 : limit,
    skip: () => disabled,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message } },
  });

export const authLimiter = make(15 * 60 * 1000, 20, 'Too many authentication attempts, try again later');
export const resetLimiter = make(60 * 60 * 1000, 5, 'Too many password reset requests');
export const uploadLimiter = make(60 * 1000, 60, 'Too many uploads, slow down');
export const apiLimiter = make(60 * 1000, 600, 'Too many requests');
export const commandLimiter = make(60 * 1000, 30, 'Too many commands');
