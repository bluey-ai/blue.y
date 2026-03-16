// @premium — BlueOnion internal only. (BLY-53/54)
// SSO via Microsoft OIDC (Azure AD) and Google OAuth2.
// Identity is proven by SSO; access is controlled by sso_invites table.
import { Router, Request, Response } from 'express';
import * as openidClient from 'openid-client';
import * as k8s from '@kubernetes/client-node';
import { config } from '../../config';
import { getSsoInvite, markInviteJoined, countJoinedInvites } from '../db';
import { getAuthorisedSeats } from '../license';
import { generateSessionToken } from '../auth';
import { logger } from '../../utils/logger';

const router = Router();

async function readSsoCmConfig(): Promise<Record<string, string>> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const namespace = config.kube.namespaces[0] || 'prod';
    const cm = await api.readNamespacedConfigMap({ name: 'blue-y-config', namespace });
    return cm.data ?? {};
  } catch { return {}; }
}

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

async function getMsConfig(): Promise<openidClient.Configuration> {
  const cm = await readSsoCmConfig();
  const tenantId     = cm['sso.microsoft.tenant_id']     || config.admin.microsoft.tenantId;
  const clientId     = cm['sso.microsoft.client_id']     || config.admin.microsoft.clientId;
  const clientSecret = cm['sso.microsoft.client_secret'] || config.admin.microsoft.clientSecret;
  const issuerUrl = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  return openidClient.discovery(new URL(issuerUrl), clientId, clientSecret);
}

// GET /admin/auth/microsoft — redirect to Azure AD
router.get('/microsoft', async (req: Request, res: Response) => {
  const cm = await readSsoCmConfig();
  const msReady = !!(
    (cm['sso.microsoft.tenant_id'] || config.admin.microsoft.tenantId) &&
    (cm['sso.microsoft.client_id'] || config.admin.microsoft.clientId) &&
    (cm['sso.microsoft.client_secret'] || config.admin.microsoft.clientSecret)
  );
  if (!msReady) {
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
  const cm2 = await readSsoCmConfig();
  const msReady2 = !!(
    (cm2['sso.microsoft.tenant_id'] || config.admin.microsoft.tenantId) &&
    (cm2['sso.microsoft.client_id'] || config.admin.microsoft.clientId) &&
    (cm2['sso.microsoft.client_secret'] || config.admin.microsoft.clientSecret)
  );
  if (!msReady2) {
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

    // Check seat limit only on first join
    if (!invite.joined_at) {
      const seats = getAuthorisedSeats();
      if (countJoinedInvites() >= seats) {
        logger.warn(`[sso/microsoft] Seat limit reached, denying first login for ${email}`);
        res.redirect('/admin/login?error=seat_limit');
        return;
      }
      markInviteJoined(email);
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

async function getGoogleConfig(): Promise<openidClient.Configuration> {
  const cm = await readSsoCmConfig();
  const clientId     = cm['sso.google.client_id']     || config.admin.google.clientId;
  const clientSecret = cm['sso.google.client_secret'] || config.admin.google.clientSecret;
  return openidClient.discovery(new URL('https://accounts.google.com'), clientId, clientSecret);
}

// GET /admin/auth/google — redirect to Google
router.get('/google', async (req: Request, res: Response) => {
  const gcm = await readSsoCmConfig();
  const googleReady = !!(
    (gcm['sso.google.client_id'] || config.admin.google.clientId) &&
    (gcm['sso.google.client_secret'] || config.admin.google.clientSecret)
  );
  if (!googleReady) {
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
  const gcm2 = await readSsoCmConfig();
  const googleReady2 = !!(
    (gcm2['sso.google.client_id'] || config.admin.google.clientId) &&
    (gcm2['sso.google.client_secret'] || config.admin.google.clientSecret)
  );
  if (!googleReady2) {
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

    // Check seat limit only on first join
    if (!invite.joined_at) {
      const seats = getAuthorisedSeats();
      if (countJoinedInvites() >= seats) {
        logger.warn(`[sso/google] Seat limit reached, denying first login for ${email}`);
        res.redirect('/admin/login?error=seat_limit');
        return;
      }
      markInviteJoined(email);
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
router.get('/providers', async (_req: Request, res: Response) => {
  const cm = await readSsoCmConfig();
  const msEnabled = !!(
    (cm['sso.microsoft.tenant_id'] || config.admin.microsoft.tenantId) &&
    (cm['sso.microsoft.client_id'] || config.admin.microsoft.clientId) &&
    (cm['sso.microsoft.client_secret'] || config.admin.microsoft.clientSecret)
  );
  const googleEnabled = !!(
    (cm['sso.google.client_id'] || config.admin.google.clientId) &&
    (cm['sso.google.client_secret'] || config.admin.google.clientSecret)
  );
  res.json({ microsoft: msEnabled, google: googleEnabled, magicLink: true });
});

export default router;
