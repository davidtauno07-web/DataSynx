import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { env, gmailConfigured } from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';

/** Read-only: DataSynx must never modify, delete or send mail. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
}

export interface EmailFull extends EmailSummary {
  body: string;
  attachments: { filename: string; mimeType: string; sizeBytes: number; attachmentId: string }[];
}

export function gmailClientFactory(): OAuth2Client {
  if (!gmailConfigured()) {
    throw serviceUnavailable('The Gmail connector is not configured on this deployment', {
      missing: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'],
    });
  }
  return new OAuth2Client({
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    redirectUri: env.GMAIL_OAUTH_REDIRECT_URI,
  });
}

export function buildConsentUrl(state: string): string {
  return gmailClientFactory().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function exchangeCode(code: string): Promise<{ credentials: string; address: string }> {
  const client = gmailClientFactory();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const profile = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
  const address = profile.data.email;
  if (!address) throw serviceUnavailable('Google did not return the mailbox address');
  return { credentials: encryptSecret(JSON.stringify(tokens)), address };
}

function authorize(credentials: string): OAuth2Client {
  const client = gmailClientFactory();
  client.setCredentials(JSON.parse(decryptSecret(credentials)));
  return client;
}

const header = (headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string =>
  headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: { text: string[]; attachments: EmailFull['attachments'] },
): void {
  if (!part) return;
  const mime = part.mimeType ?? '';
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: mime,
      sizeBytes: part.body.size ?? 0,
      attachmentId: part.body.attachmentId,
    });
  } else if (mime === 'text/plain') {
    acc.text.push(decodeBody(part.body?.data));
  } else if (mime === 'text/html' && acc.text.length === 0) {
    acc.text.push(decodeBody(part.body?.data).replace(/<[^>]+>/g, ' '));
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

/** Lists message headers only — the mailbox is never bulk-downloaded. */
export async function listMessages(
  credentials: string,
  params: { query?: string; pageToken?: string; maxResults?: number },
): Promise<{ messages: EmailSummary[]; nextPageToken?: string }> {
  const gmail = google.gmail({ version: 'v1', auth: authorize(credentials) });
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: params.query,
    pageToken: params.pageToken,
    maxResults: Math.min(params.maxResults ?? 25, 50),
  });

  const messages = await Promise.all(
    (list.data.messages ?? []).map(async (m) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: m.id as string,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
      });
      const headers = detail.data.payload?.headers;
      return {
        id: detail.data.id as string,
        threadId: detail.data.threadId ?? '',
        from: header(headers, 'From'),
        to: header(headers, 'To'),
        cc: header(headers, 'Cc'),
        subject: header(headers, 'Subject'),
        date: header(headers, 'Date'),
        snippet: detail.data.snippet ?? '',
        hasAttachments: (detail.data.payload?.parts ?? []).some((p) => Boolean(p.filename)),
      } satisfies EmailSummary;
    }),
  );

  return { messages, nextPageToken: list.data.nextPageToken ?? undefined };
}

/** Fetches the full content of a single user-selected message. */
export async function fetchMessage(credentials: string, messageId: string): Promise<EmailFull> {
  const gmail = google.gmail({ version: 'v1', auth: authorize(credentials) });
  const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = detail.data.payload?.headers;
  const acc = { text: [] as string[], attachments: [] as EmailFull['attachments'] };
  walkParts(detail.data.payload ?? undefined, acc);
  if (acc.text.length === 0) acc.text.push(decodeBody(detail.data.payload?.body?.data));

  return {
    id: detail.data.id as string,
    threadId: detail.data.threadId ?? '',
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    snippet: detail.data.snippet ?? '',
    hasAttachments: acc.attachments.length > 0,
    body: acc.text.join('\n').trim(),
    attachments: acc.attachments,
  };
}

export async function fetchAttachment(
  credentials: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const gmail = google.gmail({ version: 'v1', auth: authorize(credentials) });
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data ?? '', 'base64url');
}
