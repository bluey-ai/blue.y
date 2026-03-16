// @premium — BlueOnion internal only. (BLY-53/54)
// SSO via Microsoft OIDC (Azure AD) and Google OAuth2.
// Identity is proven by SSO; access is controlled by sso_invites table.
import { Router, Request, Response } from 'express';
import * as openidClient from 'openid-client';
import { config } from '../../config';
import { getSsoInvite } from '../db';
import { generateSessionToken } from '../auth';
import { logger } from '../../utils/logger';

const router = Router();

// In-memory PKCE state store: state → { codeVerifier, createdAt }
// Expires after 10 minutes.
const pkceStates = new Map<string, { codeVerifier: string; createdAt: number }>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pkceStates) {
    if (v.createdAt < cutoff) pkceStates.delete(k);
  }
}, 60_000).unref();

// ── Microsoft OIDC (Azure AD) ─────────────────────────────────────────────────

let msConfig: openidClient.Configuration | null = null;

async function getMsConfig(): Promise<openidClient.Configuration> {
  if (msConfig) return msConfig;
  const { tenantId, clientId, clientSecret } = config.admin.microsoft;
  const issuerUrl = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  msConfig = await openidClient.discovery(new URL(issuerUrl), clientId, clientSecret);
  return msConfig;
}

// GET /admin/auth/microsoft — redirect to Azure AD
router.get('/microsoft', async (req: Request, res: Response) => {
  if (!config.admin.microsoft.enabled) {
    res.status(503).json({ error: 'Microsoft SSO is not configured' });
    return;
  }
  try {
    const oidc = await getMsConfig();
    const state = openidClient.randomState();
    const codeVerifier = openidClient.randomPKCECodeVerifier();
    const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);

    pkceStates.set(state, { codeVerifier, createdAt: Date.now() });

    const redirectUri = `${config.admin.host}/admin/auth/microsoft/callback`;
    const url = openidClient.buildAuthorizationUrl(oidc, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(url.href);
  } catch (e: any) {
    logger.error('[sso/microsoft] Authorization redirect failed', e?.message);
    res.redirect('/admin/login?error=sso_failed');
  }
});

// GET /admin/auth/microsoft/callback — exchange code, verify invite, set session
router.get('/microsoft/callback', async (req: Request, res: Response) => {
  if (!config.admin.microsoft.enabled) {
    res.redirect('/admin/login?error=sso_disabled');
    return;
  }
  try {
    const oidc = await getMsConfig();
    const state = req.query.state as string;
    if (!state || !pkceStates.has(state)) {
      res.redirect('/admin/login?error=invalid_state');
      return;
    }
    const { codeVerifier } = pkceStates.get(state)!;
    pkceStates.delete(state);

    const redirectUri = `${config.admin.host}/admin/auth/microsoft/callback`;
    const currentUrl = new URL(`${config.admin.host}${req.originalUrl}`);
    const tokens = await openidClient.authorizationCodeGrant(oidc, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims();
    const emailRaw = (claims?.email as string | undefined) ?? (claims?.preferred_username as string | undefined) ?? '';
    const email: string = emailRaw.toLowerCase().trim();
    const name: string  = (claims?.name as string | undefined) ?? email;

    if (!email) {
      res.redirect('/admin/login?error=no_email');
      return;
    }

    // Check against sso_invites — email must be active in the invite list
    const invite = getSsoInvite(email);
    if (!invite || invite.status !== 'active') {
      logger.warn(`[sso/microsoft] Access denied for ${email} — not in invite list`);
      res.redirect('/admin/login?error=not_invited');
      return;
    }

    const sessionToken = generateSessionToken(`ms:${email}`, 'microsoft', name, invite.role);
    res.cookie('bluey_admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: config.admin.sessionTtlHours * 60 * 60 * 1000,
    });
    logger.info(`[sso/microsoft] Session started for ${email} role=${invite.role}`);
    res.redirect('/admin/');
  } catch (e: any) {
    logger.error('[sso/microsoft] Callback failed', e?.message);
    res.redirect('/admin/login?error=sso_failed');
  }
});

// ── Google OAuth2 ─────────────────────────────────────────────────────────────

let googleConfig: openidClient.Configuration | null = null;

async function getGoogleConfig(): Promise<openidClient.Configuration> {
  if (googleConfig) return googleConfig;
  const { clientId, clientSecret } = config.admin.google;
  googleConfig = await openidClient.discovery(
    new URL('https://accounts.google.com'),
    clientId,
    clientSecret,
  );
  return googleConfig;
}

// GET /admin/auth/google — redirect to Google
router.get('/google', async (req: Request, res: Response) => {
  if (!config.admin.google.enabled) {
    res.status(503).json({ error: 'Google SSO is not configured' });
    return;
  }
  try {
    const oidc = await getGoogleConfig();
    const state = openidClient.randomState();
    const codeVerifier = openidClient.randomPKCECodeVerifier();
    const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);

    pkceStates.set(state, { codeVerifier, createdAt: Date.now() });

    const redirectUri = `${config.admin.host}/admin/auth/google/callback`;
    const url = openidClient.buildAuthorizationUrl(oidc, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(url.href);
  } catch (e: any) {
    logger.error('[sso/google] Authorization redirect failed', e?.message);
    res.redirect('/admin/login?error=sso_failed');
  }
});

// GET /admin/auth/google/callback
router.get('/google/callback', async (req: Request, res: Response) => {
  if (!config.admin.google.enabled) {
    res.redirect('/admin/login?error=sso_disabled');
    return;
  }
  try {
    const oidc = await getGoogleConfig();
    const state = req.query.state as string;
    if (!state || !pkceStates.has(state)) {
      res.redirect('/admin/login?error=invalid_state');
      return;
    }
    const { codeVerifier } = pkceStates.get(state)!;
    pkceStates.delete(state);

    const redirectUri = `${config.admin.host}/admin/auth/google/callback`;
    const currentUrl = new URL(`${config.admin.host}${req.originalUrl}`);
    const tokens = await openidClient.authorizationCodeGrant(oidc, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims();
    const email: string = ((claims?.email as string | undefined) ?? '').toLowerCase().trim();
    const name: string  = (claims?.name as string | undefined) ?? email;

    if (!email) {
      res.redirect('/admin/login?error=no_email');
      return;
    }

    const invite = getSsoInvite(email);
    if (!invite || invite.status !== 'active') {
      logger.warn(`[sso/google] Access denied for ${email} — not in invite list`);
      res.redirect('/admin/login?error=not_invited');
      return;
    }

    const sessionToken = generateSessionToken(`google:${email}`, 'google', name, invite.role);
    res.cookie('bluey_admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: config.admin.sessionTtlHours * 60 * 60 * 1000,
    });
    logger.info(`[sso/google] Session started for ${email} role=${invite.role}`);
    res.redirect('/admin/');
  } catch (e: any) {
    logger.error('[sso/google] Callback failed', e?.message);
    res.redirect('/admin/login?error=sso_failed');
  }
});

// GET /admin/auth/providers — tell the frontend which SSO providers are available
router.get('/providers', (_req: Request, res: Response) => {
  res.json({
    microsoft: config.admin.microsoft.enabled,
    google:    config.admin.google.enabled,
    magicLink: true,  // always available for SuperAdmin (Telegram break-glass)
  });
});

export default router;
