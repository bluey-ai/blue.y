// @premium — BlueOnion internal only.
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { generateMagicLink, validateMagicLink, generateSessionToken, validateSession } from './auth';
import { openDb, insertIncident } from './db';
import { startConfigWatcher, stopConfigWatcher, isAdminUser } from './config-watcher';
import { setKubeClient } from './routes/cluster';
import incidentRoutes from './routes/incidents';
import configRoutes from './routes/config';
import clusterRoutes from './routes/cluster';
import { KubeClient } from '../clients/kube';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AdminModuleOptions {
  kube?: KubeClient;
  namespace?: string;
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

export async function createAdminApp(opts: AdminModuleOptions = {}): Promise<express.Router> {
  const router = express.Router();
  router.use(cookieParser());
  router.use(express.json());

  // Initialise SQLite
  openDb();

  // Start ConfigMap watcher for admin whitelist
  const namespace = opts.namespace ?? (config.kube.namespaces[0] || 'prod');
  await startConfigWatcher(namespace);

  // Wire kube client into cluster routes
  if (opts.kube) setKubeClient(opts.kube);

  // ── Auth routes ─────────────────────────────────────────────────────────────

  // Login page — shown when session is missing/expired
  router.get('/login', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BLUE.Y Admin</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
           background: #0d1117; color: #e6edf3; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px;
            padding: 40px; max-width: 380px; text-align: center; }
    h1 { font-size: 1.5rem; margin: 0 0 8px; color: #58a6ff; }
    p  { color: #8b949e; font-size: 0.875rem; line-height: 1.6; }
    code { background: #21262d; padding: 2px 6px; border-radius: 4px;
           font-family: monospace; color: #79c0ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔵 BLUE.Y Admin</h1>
    <p>Send <code>/admin</code> on Telegram, Slack, or Teams to receive a magic login link.</p>
    <p style="color:#6e7681; font-size:0.75rem;">Links expire in 4 hours and are single-use.</p>
  </div>
</body>
</html>`);
  });

  // Magic link callback — validates JWT nonce and sets session cookie
  router.get('/auth', (req: Request, res: Response) => {
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

    const sessionToken = generateSessionToken(payload.sub, payload.platform, payload.name);
    res.cookie('bluey_admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: config.admin.sessionTtlHours * 60 * 60 * 1000,
    });
    logger.info(`[admin] Session started for ${payload.platform}:${payload.sub} (${payload.name})`);
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
  router.use('/api/incidents', requireSession, incidentRoutes);
  router.use('/api/config',    requireSession, configRoutes);
  router.use('/api/cluster',   requireSession, clusterRoutes);

  // API: current session info
  router.get('/api/me', requireSession, (req: Request, res: Response) => {
    res.json((req as any).adminUser);
  });

  logger.info('[admin] Admin module initialised — routes mounted at /admin');
  return router;
}

// ── Exported helpers for main.ts ─────────────────────────────────────────────

export { generateMagicLink, isAdminUser, insertIncident };

export function shutdown(): void {
  stopConfigWatcher();
}
