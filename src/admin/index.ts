// @premium — BlueOnion internal only.
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { generateMagicLink, validateMagicLink, generateSessionToken, validateSession } from './auth';
import { openDb, insertIncident, bootstrapSuperAdmin, getAdminUser } from './db';
import { startConfigWatcher, stopConfigWatcher, isAdminUser } from './config-watcher';
import { setKubeClient } from './routes/cluster';
import { setStreamKubeClient } from './routes/stream';
import { setLogsKubeClient } from './routes/logs';
import { setDeploymentsKubeClient, setDeploymentsTelegramSend } from './routes/deployments';
import incidentRoutes from './routes/incidents';
import configRoutes from './routes/config';
import clusterRoutes from './routes/cluster';
import usersRoutes from './routes/users';
import streamRoutes from './routes/stream';
import logsRoutes from './routes/logs';
import deploymentsRoutes from './routes/deployments';
import invitesRoutes from './routes/invites';
import allowlistRoutes from './routes/allowlist';
import ssoRoutes from './routes/sso';
import integrationsRoutes from './routes/integrations';
import emailTemplatesRoutes from './routes/email-templates';
import licenseRoutes from './routes/license';
import ciRoutes from './routes/ci';
import { ipEnforcementMiddleware } from './middleware/ipEnforcement';
import { KubeClient } from '../clients/kube';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AdminModuleOptions {
  kube?: KubeClient;
  namespace?: string;
  // BLY-62: telegram send function for approval notifications
  telegramSend?: (msg: string, chatId?: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

// Session guard middleware
function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.['bluey_admin_session'];
  if (!token) { res.redirect('/admin/login'); return; }
  const session = validateSession(token);
  if (!session) { res.clearCookie('bluey_admin_session'); res.redirect('/admin/login'); return; }
  (req as any).adminUser = session;
  next();
}

// Role guard middleware factory (BLY-51)
// Role hierarchy: superadmin > admin > viewer
const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, viewer: 1 };

function requireRole(minRole: 'viewer' | 'admin' | 'superadmin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role: string = (req as any).adminUser?.role ?? 'viewer';
    if ((ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 99)) {
      next();
    } else {
      res.status(403).json({ error: `Requires ${minRole} role or higher` });
    }
  };
}

const authRateLimit = rateLimit({
  windowMs: 60_000,          // 1 minute
  max: 5,                     // 5 requests per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again in a minute.' },
});

export async function createAdminApp(opts: AdminModuleOptions = {}): Promise<express.Router> {
  const router = express.Router();
  router.use(cookieParser());
  router.use(express.json());

  // Security headers on all /admin routes
  router.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],  // needed for inline React/Vite dev
        styleSrc:    ["'self'", "'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:'],
        connectSrc:  ["'self'"],
        frameSrc:    ["'none'"],
        objectSrc:   ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,  // relaxed for SSE stream compatibility
  }));

  // Initialise SQLite + bootstrap SuperAdmin on first install (BLY-49)
  openDb();
  bootstrapSuperAdmin();

  // Start ConfigMap watcher for admin whitelist
  const namespace = opts.namespace ?? (config.kube.namespaces[0] || 'prod');
  await startConfigWatcher(namespace);

  // Wire kube client into all routes that need it
  if (opts.kube) {
    setKubeClient(opts.kube);
    setStreamKubeClient(opts.kube);
    setLogsKubeClient(opts.kube);
    setDeploymentsKubeClient(opts.kube);
  }
  // Wire Telegram sender for approval notifications (BLY-62)
  if (opts.telegramSend) {
    setDeploymentsTelegramSend(opts.telegramSend);
  }

  // IP enforcement (BLY-52) — runs BEFORE session check on all /admin routes
  // If allowlist is non-empty and request IP not in any CIDR → generic 401 (no VPN hint)
  router.use(ipEnforcementMiddleware);

  // ── Auth routes ─────────────────────────────────────────────────────────────

  // SSO routes (BLY-53/54): /auth/microsoft, /auth/microsoft/callback, /auth/google, /auth/google/callback, /auth/providers
  router.use('/auth', ssoRoutes);

  // Login page (BLY-57) — SSO buttons + magic link fallback + error states
  router.get('/login', (req: Request, res: Response) => {
    const error = req.query.error as string | undefined;
    const errorMessages: Record<string, string> = {
      not_invited:   'Your account is not authorised. Contact your administrator.',
      no_email:      'Could not retrieve email from identity provider.',
      invalid_state: 'Login session expired. Please try again.',
      sso_failed:    'SSO authentication failed. Please try again.',
      sso_disabled:  'SSO is not configured on this instance.',
      seat_limit:    'Seat limit reached — contact your administrator to upgrade the license.',
    };
    const errorHtml = error ? `
      <div class="error-box">
        ${errorMessages[error] ?? 'Authentication failed. Please try again.'}
      </div>` : '';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BLUE.Y Admin — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0d1117; color: #e6edf3; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px;
            padding: 36px 32px; width: 100%; max-width: 360px; }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
    .logo-text { font-size: 1.2rem; font-weight: 700; background: linear-gradient(90deg, #58a6ff, #bc8cff);
                 -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .logo-sub { font-size: 0.7rem; color: #6e7681; text-transform: uppercase; letter-spacing: .08em; margin-top: 1px; }
    h2 { font-size: 1rem; font-weight: 600; color: #e6edf3; margin: 0 0 6px; }
    .sub { font-size: 0.8rem; color: #8b949e; margin: 0 0 24px; }
    .sso-btn { display: flex; align-items: center; justify-content: center; width: 100%; padding: 10px 16px;
               border-radius: 8px; font-size: 0.875rem; font-weight: 500; text-decoration: none;
               transition: background 0.15s; margin-bottom: 10px; border: 1px solid #30363d; cursor: pointer; }
    .sso-btn.ms     { background: #0078d4; color: white; border-color: transparent; }
    .sso-btn.ms:hover { background: #106ebe; }
    .sso-btn.google { background: #fff; color: #3c4043; border-color: #dadce0; }
    .sso-btn.google:hover { background: #f8f9fa; }
    .divider { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #30363d; }
    .divider span { font-size: 0.75rem; color: #6e7681; }
    .magic-hint { font-size: 0.8rem; color: #8b949e; text-align: center; line-height: 1.5; }
    .magic-hint code { background: #21262d; padding: 1px 6px; border-radius: 4px; font-family: monospace; color: #79c0ff; }
    .note { margin-top: 8px; font-size: 0.7rem; color: #6e7681; text-align: center; }
    .error-box { background: rgba(248,81,73,0.1); border: 1px solid #f85149; border-radius: 8px;
                 padding: 10px 14px; margin-bottom: 20px; font-size: 0.8rem; color: #f85149; }
    #sso-area { display: none; }
    #sso-area.visible { display: block; }
    #no-sso { display: none; font-size: 0.78rem; color: #8b949e; text-align: center; margin-bottom: 12px; }
    #no-sso.visible { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20512%20512%22%3E%3Cpolygon%20points%3D%22476%2C256%20366%2C65.5%20146%2C65.5%2036%2C256%20146%2C446.5%20366%2C446.5%22%20fill%3D%22%230D1B4B%22%2F%3E%3Cpolygon%20points%3D%22298%2C112%20224%2C112%20194%2C272%20256%2C272%20218%2C402%20300%2C264%20242%2C264%22%20fill%3D%22white%22%2F%3E%3Cpath%20d%3D%22M%20183%2C364%20Q%20256%2C306%20329%2C364%22%20stroke%3D%22white%22%20stroke-width%3D%2216%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%22256%22%20cy%3D%22378%22%20r%3D%2223%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E" alt="BLUE.Y" width="36" height="36" />
      <div>
        <div class="logo-text">BLUE.Y</div>
        <div class="logo-sub">Admin</div>
      </div>
    </div>
    ${errorHtml}
    <h2>Sign in to continue</h2>
    <p class="sub">Access is restricted to authorised users only.</p>

    <!-- SSO buttons — populated by JS after fetching /admin/auth/providers -->
    <div id="sso-area"></div>
    <p id="no-sso">SSO is not configured. Contact your administrator.</p>
    <div id="divider" class="divider" style="display:none;"><span>or</span></div>

    <p class="note">Sign in with your company Microsoft or Google account.</p>
  </div>
  <script>
    (function() {
      fetch('/admin/auth/providers').then(function(r) { return r.json(); }).then(function(p) {
        var area = document.getElementById('sso-area');
        var noSso = document.getElementById('no-sso');
        var divider = document.getElementById('divider');
        var html = '';
        if (p.microsoft) {
          html += '<a href="/admin/auth/microsoft" class="sso-btn ms">' +
            '<svg width="18" height="18" viewBox="0 0 21 21" fill="none" style="margin-right:10px">' +
            '<rect x="1" y="1" width="9" height="9" fill="#f35325"/><rect x="11" y="1" width="9" height="9" fill="#81bc06"/>' +
            '<rect x="1" y="11" width="9" height="9" fill="#05a6f0"/><rect x="11" y="11" width="9" height="9" fill="#ffba08"/></svg>' +
            'Continue with Microsoft</a>';
        }
        if (p.google) {
          html += '<a href="/admin/auth/google" class="sso-btn google">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:10px">' +
            '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>' +
            '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>' +
            '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>' +
            '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>' +
            'Continue with Google</a>';
        }
        if (html) {
          area.innerHTML = html;
          area.classList.add('visible');
          divider.style.display = 'flex';
        } else {
          noSso.classList.add('visible');
        }
      }).catch(function() {
        document.getElementById('no-sso').classList.add('visible');
      });
    })();
  </script>
</body>
</html>`);
  });

  // Magic link callback — rate-limited, validates JWT nonce and sets session cookie
  router.get('/auth', authRateLimit, (req: Request, res: Response) => {
    const token = req.query.token as string;
    if (!token) { res.redirect('/admin/login'); return; }

    const payload = validateMagicLink(token);
    if (!payload) {
      res.status(401).send(`<!DOCTYPE html><html><head><title>BLUE.Y Admin</title>
        <style>body{font-family:monospace;background:#0d1117;color:#f85149;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
        </head><body><p>❌ Link expired or already used. Send <code>/admin</code> again.</p></body></html>`);
      return;
    }

    // Look up role from admin_users (BLY-49); default to 'viewer' if not found
    const adminRow = getAdminUser(payload.sub, payload.platform);
    const role = adminRow?.role ?? 'viewer';

    const sessionToken = generateSessionToken(payload.sub, payload.platform, payload.name, role);
    res.cookie('bluey_admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: config.admin.sessionTtlHours * 60 * 60 * 1000,
    });
    logger.info(`[admin] Session started for ${payload.platform}:${payload.sub} (${payload.name}) role=${role}`);
    res.redirect('/admin/');
  });

  // Logout
  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('bluey_admin_session');
    res.redirect('/admin/login');
  });

  // ── Protected dashboard ──────────────────────────────────────────────────────

  // Dashboard SPA shell (frontend served from frontend/ in premium build)
  const frontendDir = path.resolve(__dirname, '../../frontend/dist');
  router.use('/', requireSession, express.static(frontendDir, { index: false }));

  router.get('/', requireSession, (_req: Request, res: Response) => {
    const indexPath = path.join(frontendDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        // Frontend not yet built — serve minimal placeholder
        const user = (_req as any).adminUser;
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BLUE.Y Admin Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
           background: #0d1117; color: #e6edf3; margin: 0; padding: 40px; }
    h1   { color: #58a6ff; } a { color: #58a6ff; }
    .badge { background:#21262d; border:1px solid #30363d; border-radius:6px;
             padding:4px 10px; font-size:0.8rem; color:#8b949e; }
    table { border-collapse:collapse; width:100%; margin-top:16px; }
    th,td { border:1px solid #30363d; padding:8px 12px; text-align:left; font-size:0.875rem; }
    th { background:#161b22; color:#8b949e; }
  </style>
</head>
<body>
  <h1>🔵 BLUE.Y Admin Dashboard</h1>
  <p><span class="badge">Logged in as ${user?.name} via ${user?.platform}</span>
     &nbsp; <a href="/admin/api/incidents">Incidents API</a>
     &nbsp; <a href="/admin/api/cluster/status">Cluster API</a>
     &nbsp; <form style="display:inline" method="POST" action="/admin/logout">
       <button type="submit" style="background:none;border:none;color:#f85149;cursor:pointer">Logout</button>
     </form>
  </p>
  <p style="color:#8b949e">React dashboard (frontend/) will appear here once built — BLY-36.</p>
</body>
</html>`);
      }
    });
  });

  // ── REST API (protected) ─────────────────────────────────────────────────────
  // No caching on any API response
  router.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // viewer+  — read-only data
  router.use('/api/incidents',   requireSession, requireRole('viewer'), incidentRoutes);
  router.use('/api/cluster',     requireSession, requireRole('viewer'), clusterRoutes);
  router.use('/api/stream',      requireSession, requireRole('viewer'), streamRoutes);
  router.use('/api/logs',        requireSession, requireRole('viewer'), logsRoutes);

  // admin+   — operational actions (restart/scale handled per-route inside deployments)
  router.use('/api/deployments', requireSession, requireRole('viewer'), deploymentsRoutes);

  // superadmin only — system config and user management
  router.use('/api/config',      requireSession, requireRole('superadmin'), configRoutes);
  router.use('/api/users',       requireSession, requireRole('superadmin'), usersRoutes);
  router.use('/api/invites',     requireSession, requireRole('superadmin'), invitesRoutes);
  router.use('/api/allowlist',   requireSession, requireRole('superadmin'), allowlistRoutes);

  // integrations — GET: all roles (secrets masked for non-superadmin), PUT: superadmin only (enforced inside route)
  router.use('/api/integrations', requireSession, requireRole('viewer'), integrationsRoutes);

  // email templates — superadmin only (BLY-67)
  router.use('/api/email-templates', requireSession, requireRole('superadmin'), emailTemplatesRoutes);

  // license — GET: all roles (show plan/seats), POST /verify: superadmin only
  router.use('/api/license',      requireSession, requireRole('viewer'), licenseRoutes);
  router.use('/api/ci',           requireSession, requireRole('superadmin'), ciRoutes); // BLY-70

  // API: current session info + build version
  router.get('/api/me', requireSession, (req: Request, res: Response) => {
    const buildVersion = process.env.BUILD_VERSION || process.env.npm_package_version || '1.8.0';
    res.json({ ...(req as any).adminUser, version: buildVersion });
  });

  logger.info('[admin] Admin module initialised — routes mounted at /admin');
  return router;
}

// ── Exported helpers for main.ts ─────────────────────────────────────────────

export { generateMagicLink, isAdminUser, insertIncident };

/**
 * BLY-60: Check if a Telegram user is SuperAdmin.
 * Used to gate the /admin magic-link command — only SuperAdmins may use it.
 */
export function isSuperAdmin(telegramId: string): boolean {
  const row = getAdminUser(telegramId, 'telegram');
  return row?.role === 'superadmin';
}

export function shutdown(): void {
  stopConfigWatcher();
}
