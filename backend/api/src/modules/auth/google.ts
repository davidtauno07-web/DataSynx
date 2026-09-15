import { OAuth2Client } from 'google-auth-library';
import { env, googleOAuthConfigured } from '../../config/env.js';
import { serviceUnavailable, unauthorized } from '../../lib/errors.js';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
}

function client(): OAuth2Client {
  if (!googleOAuthConfigured()) {
    throw serviceUnavailable(
      'Google sign-in is not configured on this deployment',
      { missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
    );
  }
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  });
}

export function buildAuthUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

export async function exchangeCode(code: string): Promise<GoogleProfile> {
  const oauth = client();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw unauthorized('Google did not return an identity token');

  const ticket = await oauth.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw unauthorized('Google profile is incomplete');
  if (payload.email_verified === false) throw unauthorized('Google account email is not verified');

  return { googleId: payload.sub, email: payload.email, name: payload.name ?? '' };
}
