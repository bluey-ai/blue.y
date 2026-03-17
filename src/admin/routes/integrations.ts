// @premium — BlueOnion internal only. (BLY-59)
// Integrations config — Telegram, Slack, Teams, WhatsApp, Email/SES.
// Read: all roles (secrets masked for non-superadmin).
// Write: superadmin only (handled via requireRole in index.ts).
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { SESClient, GetSendQuotaCommand } from '@aws-sdk/client-ses';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const CONFIG_MAP_NAME = 'blue-y-config';
const SENSITIVE_SUFFIX = ['token', 'secret', 'sid', 'key', 'password'];

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}
function getNamespace(): string {
  return config.kube.namespaces[0] || 'prod';
}
function isK8sNotFound(e: any): boolean {
  if (e?.response?.statusCode === 404) return true;
  try {
    const body = typeof e?.body === 'string' ? JSON.parse(e.body) : e?.body;
    if (body?.reason === 'NotFound') return true;
  } catch {}
  return String(e?.message ?? '').includes('HTTP-Code: 404');
}

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_SUFFIX.some(s => lower.endsWith(s));
}
function maskValue(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return val.slice(0, 4) + '•'.repeat(val.length - 8) + val.slice(-4);
}

// Integration definitions — keys stored in ConfigMap under these names
const INTEGRATIONS = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: 'telegram',
    fields: [
      { key: 'telegram.bot_token',  label: 'Bot Token',  type: 'password' },
      { key: 'telegram.chat_id',    label: 'Chat ID',    type: 'text'     },
      { key: 'telegram.admin_id',   label: 'Admin ID',   type: 'text'     },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: 'slack',
    fields: [
      { key: 'slack.app_token',   label: 'App Token (xapp)',  type: 'password' },
      { key: 'slack.bot_token',   label: 'Bot Token (xoxb)',  type: 'password' },
      { key: 'slack.channel_id',  label: 'Channel ID',        type: 'text'     },
    ],
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    icon: 'microsoft',
    fields: [
      { key: 'teams.tenant_id',     label: 'Tenant ID',     type: 'text'     },
      { key: 'teams.client_id',     label: 'Client ID',     type: 'text'     },
      { key: 'teams.client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp (Twilio)',
    icon: 'whatsapp',
    fields: [
      { key: 'whatsapp.account_sid', label: 'Account SID',  type: 'text'     },
      { key: 'whatsapp.auth_token',  label: 'Auth Token',   type: 'password' },
      { key: 'whatsapp.from',        label: 'From Number',  type: 'text'     },
    ],
  },
  {
    id: 'email',
    label: 'Email (AWS SES)',
    icon: 'email',
    fields: [
      { key: 'email.from',       label: 'FROM Address',    type: 'text' },
      { key: 'email.to',         label: 'Alert Recipient', type: 'text' },
      { key: 'email.ses_region', label: 'SES Region',      type: 'text' },
    ],
  },
  {
    id: 'microsoft-sso',
    label: 'Microsoft SSO (Azure AD)',
    icon: 'microsoft-sso',
    fields: [
      { key: 'sso.microsoft.tenant_id',     label: 'Tenant ID',     type: 'text'     },
      { key: 'sso.microsoft.client_id',     label: 'Client ID',     type: 'text'     },
      { key: 'sso.microsoft.client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
  {
    id: 'google-sso',
    label: 'Google SSO',
    icon: 'google-sso',
    fields: [
      { key: 'sso.google.client_id',     label: 'Client ID',     type: 'text'     },
      { key: 'sso.google.client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    icon: 'bitbucket',
    fields: [
      { key: 'ci.bitbucket.token',     label: 'API Token (repository:write)',  type: 'password' },
      { key: 'ci.bitbucket.workspace', label: 'Workspace slug',                type: 'text'     },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    icon: 'github',
    fields: [
      { key: 'ci.github.token', label: 'Personal Access Token (repo scope)', type: 'password' },
      { key: 'ci.github.org',   label: 'Organisation / User',                type: 'text'     },
    ],
  },
];

// GET /api/integrations — returns integration status with masked secrets for non-superadmin
router.get('/', async (req: Request, res: Response) => {
  const coreApi = getCoreApi();
  const namespace = getNamespace();
  let configData: Record<string, string> = {};
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
    configData = cm.data ?? {};
  } catch (e: any) {
    if (!isK8sNotFound(e)) {
      res.status(500).json({ error: e?.message ?? String(e) }); return;
    }
  }

  const isSuperAdmin = (req as any).adminUser?.role === 'superadmin';
  const result = INTEGRATIONS.map(intg => {
    const fields = intg.fields.map(f => {
      const raw = configData[f.key] ?? '';
      const value = (isSuperAdmin || !isSensitive(f.key)) ? raw : maskValue(raw);
      return { ...f, value, hasValue: !!raw };
    });
    const enabled = fields.some(f => f.hasValue);
    return { ...intg, enabled, fields };
  });

  res.json({ integrations: result, readOnly: !isSuperAdmin });
});

// PUT /api/integrations/:id — update an integration (superadmin only, enforced in index.ts)
router.put('/:id', async (req: Request, res: Response) => {
  const intgId = req.params.id as string;
  const intg = INTEGRATIONS.find(i => i.id === intgId);
  if (!intg) { res.status(404).json({ error: `Unknown integration: ${intgId}` }); return; }

  const updates = req.body?.fields as Record<string, string> | undefined;
  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ error: 'Body must be { "fields": { "key": "value", ... } }' });
    return;
  }

  const allowedKeys = new Set(intg.fields.map(f => f.key));
  for (const k of Object.keys(updates)) {
    if (!allowedKeys.has(k)) {
      res.status(400).json({ error: `Unknown field for ${intgId}: ${k}` });
      return;
    }
  }

  const coreApi = getCoreApi();
  const namespace = getNamespace();
  const caller = (req as any).adminUser?.name ?? 'unknown';

  try {
    // Read existing ConfigMap first (or create if not exists)
    let currentData: Record<string, string> = {};
    try {
      const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
      currentData = cm.data ?? {};
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
    }

    // Apply updates (skip empty strings — removes the key)
    for (const [k, v] of Object.entries(updates)) {
      if (v === '') {
        delete currentData[k];
      } else {
        currentData[k] = v;
      }
    }

    // Write back
    try {
      await coreApi.replaceNamespacedConfigMap({
        name: CONFIG_MAP_NAME, namespace,
        body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: currentData },
      });
    } catch (e: any) {
      if (isK8sNotFound(e)) {
        await coreApi.createNamespacedConfigMap({
          namespace,
          body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: currentData },
        });
      } else { throw e; }
    }

    logger.info(`[admin] Integration '${intgId}' updated by ${caller}`);
    res.json({ ok: true, integration: intgId });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/integrations/:id/test — live connectivity check (superadmin only)
router.post('/:id/test', async (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role !== 'superadmin') { res.status(403).json({ error: 'Requires superadmin' }); return; }

  const intgId = req.params.id as string;
  const intg = INTEGRATIONS.find(i => i.id === intgId);
  if (!intg) { res.status(404).json({ error: `Unknown integration: ${intgId}` }); return; }

  // Read current config from ConfigMap
  let configData: Record<string, string> = {};
  try {
    const coreApi = getCoreApi();
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace: getNamespace() });
    configData = cm.data ?? {};
  } catch (e: any) {
    if (!isK8sNotFound(e)) {
      res.status(500).json({ ok: false, status: 'error', message: 'Failed to read config' }); return;
    }
  }

  try {
    const result = await testIntegration(intgId, configData);
    res.json(result);
  } catch (e: any) {
    res.json({ ok: false, status: 'failed', message: e?.message ?? String(e) });
  }
});

async function testIntegration(id: string, cfg: Record<string, string>): Promise<{ ok: boolean; status: 'connected' | 'failed' | 'not_configured'; message: string }> {
  const timeout = 6000;
  const fetchOpts = { signal: AbortSignal.timeout(timeout) };

  if (id === 'telegram') {
    const token = cfg['telegram.bot_token'];
    if (!token) return { ok: false, status: 'not_configured', message: 'Bot Token not set' };
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, fetchOpts);
    const body = await r.json() as { ok: boolean; result?: { username: string } };
    if (body.ok) return { ok: true, status: 'connected', message: `@${body.result?.username ?? 'bot'} is online` };
    return { ok: false, status: 'failed', message: 'Invalid bot token' };
  }

  if (id === 'slack') {
    const botToken = cfg['slack.bot_token'];
    if (!botToken) return { ok: false, status: 'not_configured', message: 'Bot Token not set' };
    const r = await fetch('https://slack.com/api/auth.test', {
      ...fetchOpts,
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    });
    const body = await r.json() as { ok: boolean; team?: string; error?: string };
    if (body.ok) return { ok: true, status: 'connected', message: `Connected to workspace: ${body.team ?? '–'}` };
    return { ok: false, status: 'failed', message: body.error ?? 'Auth failed' };
  }

  if (id === 'microsoft') {
    const tenantId = cfg['teams.tenant_id'];
    const clientId = cfg['teams.client_id'];
    const clientSecret = cfg['teams.client_secret'];
    if (!tenantId || !clientId || !clientSecret) return { ok: false, status: 'not_configured', message: 'Tenant ID / Client ID / Client Secret not set' };
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' });
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, { ...fetchOpts, method: 'POST', body });
    const json = await r.json() as { access_token?: string; error?: string; error_description?: string };
    if (json.access_token) return { ok: true, status: 'connected', message: 'Azure AD credentials valid' };
    return { ok: false, status: 'failed', message: json.error_description?.split('\r\n')[0] ?? json.error ?? 'Auth failed' };
  }

  if (id === 'whatsapp') {
    const sid = cfg['whatsapp.account_sid'];
    const token = cfg['whatsapp.auth_token'];
    if (!sid || !token) return { ok: false, status: 'not_configured', message: 'Account SID / Auth Token not set' };
    const creds = Buffer.from(`${sid}:${token}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { ...fetchOpts, headers: { Authorization: `Basic ${creds}` } });
    if (r.ok) {
      const json = await r.json() as { friendly_name?: string };
      return { ok: true, status: 'connected', message: `Account: ${json.friendly_name ?? sid}` };
    }
    return { ok: false, status: 'failed', message: `HTTP ${r.status} — check credentials` };
  }

  if (id === 'email') {
    const from = cfg['email.from'];
    const to   = cfg['email.to'];
    if (!from || !to) return { ok: false, status: 'not_configured', message: 'FROM address and Alert Recipient not set' };
    const region = cfg['email.ses_region'] || 'ap-southeast-1';
    try {
      const ses = new SESClient({ region });
      const quota = await ses.send(new GetSendQuotaCommand({}));
      const sent  = Math.round(quota.SentLast24Hours ?? 0);
      const max   = quota.Max24HourSend ?? 0;
      return { ok: true, status: 'connected', message: `SES reachable (${region}) — ${sent}/${max} emails sent today` };
    } catch (e: any) {
      return { ok: false, status: 'failed', message: e?.message ?? 'SES connection failed — check IAM/IRSA permissions' };
    }
  }

  if (id === 'microsoft-sso') {
    const tenantId     = cfg['sso.microsoft.tenant_id']     || process.env.MICROSOFT_TENANT_ID     || '';
    const clientId     = cfg['sso.microsoft.client_id']     || process.env.MICROSOFT_CLIENT_ID     || '';
    const clientSecret = cfg['sso.microsoft.client_secret'] || process.env.MICROSOFT_CLIENT_SECRET || '';
    if (!tenantId || !clientId || !clientSecret) return { ok: false, status: 'not_configured', message: 'Tenant ID / Client ID / Client Secret not set' };
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' });
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, { ...fetchOpts, method: 'POST', body });
    const json = await r.json() as { access_token?: string; error?: string; error_description?: string };
    if (json.access_token) return { ok: true, status: 'connected', message: 'Azure AD credentials valid — SSO ready' };
    return { ok: false, status: 'failed', message: json.error_description?.split('\r\n')[0] ?? json.error ?? 'Auth failed' };
  }

  if (id === 'google-sso') {
    const clientId     = cfg['sso.google.client_id']     || process.env.GOOGLE_CLIENT_ID     || '';
    const clientSecret = cfg['sso.google.client_secret'] || process.env.GOOGLE_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) return { ok: false, status: 'not_configured', message: 'Client ID / Client Secret not set' };
    // Verify the discovery doc is reachable (confirms credentials format is valid)
    const r = await fetch('https://accounts.google.com/.well-known/openid-configuration', fetchOpts);
    if (r.ok) return { ok: true, status: 'connected', message: 'Google credentials saved — SSO ready' };
    return { ok: false, status: 'failed', message: 'Could not reach Google OIDC discovery endpoint' };
  }

  if (id === 'bitbucket') {
    const token     = cfg['ci.bitbucket.token'];
    const workspace = cfg['ci.bitbucket.workspace'];
    if (!token) return { ok: false, status: 'not_configured', message: 'API Token not set' };
    const r = await fetch('https://api.bitbucket.org/2.0/user', {
      ...fetchOpts,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const json = await r.json() as { display_name?: string; username?: string };
      const who = json.display_name ?? json.username ?? '–';
      return { ok: true, status: 'connected', message: `Authenticated as ${who}${workspace ? ` — workspace: ${workspace}` : ''}` };
    }
    return { ok: false, status: 'failed', message: `HTTP ${r.status} — check token (needs repository:write scope)` };
  }

  if (id === 'github') {
    const token = cfg['ci.github.token'];
    const org   = cfg['ci.github.org'];
    if (!token) return { ok: false, status: 'not_configured', message: 'Personal Access Token not set' };
    const r = await fetch('https://api.github.com/user', {
      ...fetchOpts,
      headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BLUE.Y' },
    });
    if (r.ok) {
      const json = await r.json() as { login?: string; name?: string };
      const who = json.name ?? json.login ?? '–';
      return { ok: true, status: 'connected', message: `Authenticated as ${who}${org ? ` — org: ${org}` : ''}` };
    }
    return { ok: false, status: 'failed', message: `HTTP ${r.status} — check token (needs repo scope)` };
  }

  return { ok: false, status: 'failed', message: 'Unknown integration' };
}

export default router;
