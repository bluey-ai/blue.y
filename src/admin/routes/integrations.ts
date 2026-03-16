// @premium — BlueOnion internal only. (BLY-59)
// Integrations config — Telegram, Slack, Teams, WhatsApp.
// Read: all roles (secrets masked for non-superadmin).
// Write: superadmin only (handled via requireRole in index.ts).
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
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
    if (e?.response?.statusCode !== 404) {
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
      if (e?.response?.statusCode === 404) {
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

export default router;
