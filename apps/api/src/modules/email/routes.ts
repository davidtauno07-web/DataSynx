import { Router } from 'express';
import { z } from 'zod';
import { EmailProvider, ImportSource, Modality } from '@prisma/client';
import { env, gmailConfigured } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { randomToken, safeEqual } from '../../lib/crypto.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { apiLimiter } from '../../middleware/rateLimit.js';
import { recordAudit, requestContext } from '../audit/service.js';
import { createImport, ingestFile } from '../ingestion/service.js';
import * as gmail from './gmail.js';

const STATE_COOKIE = 'dsx_gmail_state';

export const emailRouter = Router();
emailRouter.use(apiLimiter);

emailRouter.get('/config', (_req, res) => {
  res.json({ gmailEnabled: gmailConfigured(), providers: ['GMAIL'] });
});

emailRouter.get(
  '/accounts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const accounts = await prisma.emailAccount.findMany({
      where: { workspaceId: auth.workspaceId, userId: auth.sub },
      select: { id: true, provider: true, address: true, connectedAt: true, lastUsedAt: true, scopes: true },
      orderBy: { connectedAt: 'desc' },
    });
    res.json({ accounts });
  }),
);

emailRouter.get(
  '/gmail/connect',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const state = `${randomToken(12)}.${auth.sub}`;
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.json({ url: gmail.buildConsentUrl(state) });
  }),
);

emailRouter.get(
  '/gmail/callback',
  asyncHandler(async (req, res) => {
    const query = z
      .object({ code: z.string().min(1).optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);
    if (query.error) throw badRequest(`Gmail authorisation failed: ${query.error}`);

    const cookieState = req.cookies?.[STATE_COOKIE];
    if (!query.code || !query.state || typeof cookieState !== 'string' || !safeEqual(cookieState, query.state)) {
      throw badRequest('Invalid OAuth state');
    }
    const userId = query.state.split('.')[1];
    if (!userId) throw badRequest('Invalid OAuth state');
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const member = await prisma.workspaceMember.findFirst({ where: { userId } });
    if (!member) throw notFound('Workspace not found for this user');

    const { credentials, address } = await gmail.exchangeCode(query.code);
    const account = await prisma.emailAccount.upsert({
      where: {
        workspaceId_provider_address: {
          workspaceId: member.workspaceId,
          provider: EmailProvider.GMAIL,
          address,
        },
      },
      create: {
        workspaceId: member.workspaceId,
        userId,
        provider: EmailProvider.GMAIL,
        address,
        credentials,
        scopes: gmail.GMAIL_SCOPES,
      },
      update: { credentials, scopes: gmail.GMAIL_SCOPES },
    });

    await recordAudit({
      ...requestContext(req),
      workspaceId: member.workspaceId,
      userId,
      action: 'email.connected',
      entityType: 'EmailAccount',
      entityId: account.id,
      after: { provider: 'GMAIL', address },
    });

    res.redirect(`${env.WEB_PUBLIC_URL}/import?connector=gmail&status=connected`);
  }),
);

async function loadAccount(workspaceId: string, userId: string, accountId: string) {
  const account = await prisma.emailAccount.findFirst({ where: { id: accountId, workspaceId, userId } });
  if (!account) throw notFound('Email account not connected');
  return account;
}

emailRouter.get(
  '/accounts/:accountId/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const params = z.object({ accountId: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ q: z.string().max(300).optional(), pageToken: z.string().optional(), max: z.coerce.number().min(1).max(50).default(25) })
      .parse(req.query);

    const account = await loadAccount(auth.workspaceId, auth.sub, params.accountId);
    const result = await gmail.listMessages(account.credentials, {
      query: query.q,
      pageToken: query.pageToken,
      maxResults: query.max,
    });
    await prisma.emailAccount.update({ where: { id: account.id }, data: { lastUsedAt: new Date() } });
    res.json(result);
  }),
);

const importSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  includeAttachments: z.boolean().default(true),
});

/** Imports only the messages the user explicitly selected. */
emailRouter.post(
  '/accounts/:accountId/import',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const params = z.object({ accountId: z.string().uuid() }).parse(req.params);
    const body = importSchema.parse(req.body);
    const account = await loadAccount(auth.workspaceId, auth.sub, params.accountId);

    const imported = await createImport({
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      source: ImportSource.EMAIL_CONNECTOR,
      label: `Gmail — ${account.address}`,
      metadata: { provider: 'GMAIL', address: account.address, selected: body.messageIds.length },
    });

    const files: { id: string; reference: string; originalName: string; modality: Modality }[] = [];
    const failures: { messageId: string; error: string }[] = [];

    for (const messageId of body.messageIds) {
      try {
        const message = await gmail.fetchMessage(account.credentials, messageId);
        const raw = [
          `From: ${message.from}`,
          `To: ${message.to}`,
          message.cc ? `Cc: ${message.cc}` : null,
          `Subject: ${message.subject}`,
          `Date: ${message.date}`,
          '',
          message.body,
        ]
          .filter((l) => l !== null)
          .join('\n');

        const ingested = await ingestFile({
          workspaceId: auth.workspaceId,
          userId: auth.sub,
          importId: imported.id,
          hint: 'email',
          modalityOverride: Modality.EMAIL,
          file: {
            originalname: `${(message.subject || 'email').replace(/[^\w\-. ]+/g, '_').slice(0, 80)}.eml`,
            mimetype: 'message/rfc822',
            size: Buffer.byteLength(raw),
            buffer: Buffer.from(raw, 'utf8'),
          },
          metadata: {
            provider: 'GMAIL',
            messageId: message.id,
            threadId: message.threadId,
            from: message.from,
            to: message.to,
            cc: message.cc,
            subject: message.subject,
            date: message.date,
            body: message.body,
            attachmentCount: message.attachments.length,
          },
        });
        files.push({
          id: ingested.file.id,
          reference: ingested.file.reference,
          originalName: ingested.file.originalName,
          modality: ingested.file.modality,
        });

        if (body.includeAttachments) {
          for (const attachment of message.attachments) {
            try {
              const buffer = await gmail.fetchAttachment(account.credentials, message.id, attachment.attachmentId);
              const att = await ingestFile({
                workspaceId: auth.workspaceId,
                userId: auth.sub,
                importId: imported.id,
                file: {
                  originalname: attachment.filename,
                  mimetype: attachment.mimeType,
                  size: buffer.byteLength,
                  buffer,
                },
                metadata: { fromEmailMessageId: message.id, subject: message.subject },
              });
              files.push({
                id: att.file.id,
                reference: att.file.reference,
                originalName: att.file.originalName,
                modality: att.file.modality,
              });
            } catch (err) {
              failures.push({
                messageId: `${messageId}:${attachment.filename}`,
                error: err instanceof Error ? err.message : 'Attachment import failed',
              });
            }
          }
        }
      } catch (err) {
        failures.push({ messageId, error: err instanceof Error ? err.message : 'Import failed' });
      }
    }

    await recordAudit({
      ...requestContext(req),
      workspaceId: auth.workspaceId,
      userId: auth.sub,
      action: 'email.import',
      entityType: 'Import',
      entityId: imported.id,
      after: { requested: body.messageIds.length, imported: files.length, failed: failures.length },
    });

    res.status(201).json({ import: { id: imported.id, reference: imported.reference }, files, failures });
  }),
);
