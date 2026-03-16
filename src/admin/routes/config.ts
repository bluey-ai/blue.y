// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { getAdminUsers } from '../config-watcher';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const CONFIG_MAP_NAME = 'blue-y-config';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

function getNamespace(): string {
  return config.kube.namespaces[0] || 'prod';
}

// GET /api/config — current blue-y-config ConfigMap values + admin users
router.get('/', async (_req: Request, res: Response) => {
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
    // ConfigMap doesn't exist yet — return empty (not an error)
  }
  res.json({
    configMap: configData,
    adminUsers: getAdminUsers(),
    note: 'configMap reflects blue-y-config. adminUsers reflect blue-y-admin-users (hot-reloaded every 30s).',
  });
});

// PUT /api/config — overwrite blue-y-config ConfigMap
// Body: { "data": { "key": "value", ... } }
router.put('/', async (req: Request, res: Response) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    res.status(400).json({ error: 'Body must be { "data": { "key": "value", ... } }' });
    return;
  }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') {
      res.status(400).json({ error: `Value for key "${k}" must be a string` });
      return;
    }
  }

  const coreApi = getCoreApi();
  const namespace = getNamespace();
  const caller = (req as any).adminUser?.name ?? 'unknown';

  try {
    try {
      await coreApi.replaceNamespacedConfigMap({
        name: CONFIG_MAP_NAME,
        namespace,
        body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: data as Record<string, string> },
      });
    } catch (e: any) {
      if (e?.response?.statusCode === 404) {
        await coreApi.createNamespacedConfigMap({
          namespace,
          body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: data as Record<string, string> },
        });
      } else {
        throw e;
      }
    }
    logger.info(`[admin] blue-y-config updated by ${caller} (${Object.keys(data).length} keys)`);
    res.json({ ok: true, keys: Object.keys(data).length, updatedBy: caller });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
