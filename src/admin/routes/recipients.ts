// BLY-73 — Alert Recipient Directory
// Universal contact list for alert notifications.
// Recipients are stored as a JSON array in blue-y-config ConfigMap under key "alert.recipients".
// Each entry: { id, name, email, type: 'internal'|'client', tags }
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const CONFIG_MAP_NAME = 'blue-y-config';
const RECIPIENTS_KEY  = 'alert.recipients';

export interface AlertRecipient {
  id: string;      // UUID
  name: string;
  email: string;
  type: 'internal' | 'client';
  tags: string;    // comma-separated, optional
}

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

async function readRecipients(): Promise<AlertRecipient[]> {
  const coreApi = getCoreApi();
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace: getNamespace() });
    const raw = cm.data?.[RECIPIENTS_KEY];
    if (!raw) return [];
    return JSON.parse(raw) as AlertRecipient[];
  } catch (e: any) {
    if (isK8sNotFound(e)) return [];
    throw e;
  }
}

async function writeRecipients(recipients: AlertRecipient[]): Promise<void> {
  const coreApi = getCoreApi();
  const namespace = getNamespace();
  const raw = JSON.stringify(recipients);

  let currentData: Record<string, string> = {};
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
    currentData = cm.data ?? {};
  } catch (e: any) {
    if (!isK8sNotFound(e)) throw e;
  }

  currentData[RECIPIENTS_KEY] = raw;

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
    } else {
      throw e;
    }
  }
}

// GET /api/recipients — list all recipients
router.get('/', async (_req: Request, res: Response) => {
  try {
    const recipients = await readRecipients();
    res.json({ recipients, count: recipients.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/recipients — add a new recipient (superadmin only via index.ts)
router.post('/', async (req: Request, res: Response) => {
  const { name, email, type, tags } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'valid email is required' }); return;
  }
  if (type !== 'internal' && type !== 'client') {
    res.status(400).json({ error: 'type must be "internal" or "client"' }); return;
  }

  try {
    const recipients = await readRecipients();
    if (recipients.some(r => r.email.toLowerCase() === email.toLowerCase())) {
      res.status(409).json({ error: `${email} is already in the recipient list` }); return;
    }

    const newRecipient: AlertRecipient = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      type: type as 'internal' | 'client',
      tags: typeof tags === 'string' ? tags.trim() : '',
    };

    recipients.push(newRecipient);
    await writeRecipients(recipients);

    const caller = (req as any).adminUser?.name ?? 'unknown';
    logger.info(`[recipients] Added ${email} (${type}) by ${caller}`);
    res.json({ ok: true, recipient: newRecipient });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// PATCH /api/recipients/:id — update a recipient
router.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, type, tags } = req.body ?? {};

  try {
    const recipients = await readRecipients();
    const idx = recipients.findIndex(r => r.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Recipient not found' }); return; }

    if (name !== undefined) recipients[idx].name = String(name).trim();
    if (type === 'internal' || type === 'client') recipients[idx].type = type;
    if (tags !== undefined) recipients[idx].tags = String(tags).trim();

    await writeRecipients(recipients);
    const caller = (req as any).adminUser?.name ?? 'unknown';
    logger.info(`[recipients] Updated ${recipients[idx].email} by ${caller}`);
    res.json({ ok: true, recipient: recipients[idx] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// DELETE /api/recipients/:id — remove a recipient
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const recipients = await readRecipients();
    const idx = recipients.findIndex(r => r.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Recipient not found' }); return; }

    const removed = recipients.splice(idx, 1)[0];
    await writeRecipients(recipients);
    const caller = (req as any).adminUser?.name ?? 'unknown';
    logger.info(`[recipients] Removed ${removed.email} by ${caller}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
