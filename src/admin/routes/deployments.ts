// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { KubeClient } from '../../clients/kube';
import { logger } from '../../utils/logger';

let kubeClient: KubeClient | null = null;

export function setDeploymentsKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}

const router = Router();

// GET /api/deployments?namespace=X
router.get('/', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const deployments = await kubeClient.getDeployments(namespace);
    res.json({ deployments, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/deployments/restart — rolling restart
router.post('/restart', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, deployment } = req.body ?? {};
  if (!namespace || !deployment) {
    res.status(400).json({ error: 'namespace and deployment are required' });
    return;
  }
  try {
    const ok = await kubeClient.restartDeployment(namespace, deployment);
    if (ok) {
      logger.info(`[admin] Restarted ${namespace}/${deployment} via dashboard by ${(req as any).adminUser?.name}`);
      res.json({ ok: true, message: `Rolling restart triggered for ${deployment}` });
    } else {
      res.status(500).json({ error: 'Restart failed — check deployment name and namespace' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/deployments/scale
router.post('/scale', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, deployment, replicas } = req.body ?? {};
  if (!namespace || !deployment || replicas === undefined) {
    res.status(400).json({ error: 'namespace, deployment, and replicas are required' });
    return;
  }
  const r = parseInt(String(replicas), 10);
  if (isNaN(r) || r < 0 || r > 20) {
    res.status(400).json({ error: 'replicas must be 0–20' });
    return;
  }
  try {
    const ok = await kubeClient.scaleDeployment(namespace, deployment, r);
    if (ok) {
      logger.info(`[admin] Scaled ${namespace}/${deployment} → ${r} via dashboard by ${(req as any).adminUser?.name}`);
      res.json({ ok: true, message: `Scaled ${deployment} to ${r} replica${r !== 1 ? 's' : ''}` });
    } else {
      res.status(500).json({ error: 'Scale failed' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
