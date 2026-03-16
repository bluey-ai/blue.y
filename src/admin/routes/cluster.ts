// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { KubeClient } from '../../clients/kube';

let kubeClient: KubeClient | null = null;

export function setKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}

const router = Router();

// GET /api/cluster/status — live cluster overview
router.get('/status', async (_req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  try {
    const [summary, nodes, namespaces] = await Promise.all([
      kubeClient.getClusterSummary(),
      kubeClient.getNodes(),
      kubeClient.getUserNamespaces(),
    ]);
    res.json({ summary, nodes, namespaces });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/cluster/pods?namespace=prod
router.get('/pods', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const pods = await kubeClient.getPods(namespace);
    res.json({ pods, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/cluster/nodes
router.get('/nodes', async (_req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  try {
    const nodes = await kubeClient.getNodes();
    res.json({ nodes });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
