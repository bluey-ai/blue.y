// @premium — BlueOnion internal only.
import { Router, Request, Response, NextFunction } from 'express';
import { KubeClient } from '../../clients/kube';
import { logger } from '../../utils/logger';
import type * as k8s from '@kubernetes/client-node';

const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, viewer: 1 };
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if ((ROLE_RANK[role] ?? 0) >= 2) { next(); return; }
  res.status(403).json({ error: 'Requires admin role or higher' });
}

let kubeClient: KubeClient | null = null;

export function setNetworkKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}

const router = Router();

// GET /api/network/health?namespace=X — full ingress→svc→endpoints chain walk
router.get('/health', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const routes = await kubeClient.routeHealthWalk(namespace);
    const summary = {
      total:  routes.length,
      green:  routes.filter(r => r.health === 'green').length,
      yellow: routes.filter(r => r.health === 'yellow').length,
      red:    routes.filter(r => r.health === 'red').length,
    };
    res.json({ routes, summary, namespace });
  } catch (e: any) {
    logger.error('[network] routeHealthWalk error:', e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── Ingresses ────────────────────────────────────────────────────────────────

// GET /api/network/ingresses?namespace=X
router.get('/ingresses', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const ingresses = await kubeClient.listIngresses(namespace);
    res.json({ ingresses, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/network/ingresses — create (admin+)
router.post('/ingresses', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, body } = req.body as { namespace: string; body: k8s.V1Ingress };
  if (!namespace || !body) { res.status(400).json({ error: 'namespace and body are required' }); return; }
  try {
    const result = await kubeClient.createIngress(namespace, body);
    logger.info(`[network] Created ingress ${body.metadata?.name} in ${namespace}`);
    res.json({ ok: true, ingress: result });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// PUT /api/network/ingresses/:namespace/:name — update (admin+)
router.put('/ingresses/:namespace/:name', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = req.params['namespace'] as string;
  const name = req.params['name'] as string;
  const { body } = req.body as { body: k8s.V1Ingress };
  if (!body) { res.status(400).json({ error: 'body is required' }); return; }
  try {
    const result = await kubeClient.updateIngress(namespace, name, body);
    logger.info(`[network] Updated ingress ${name} in ${namespace}`);
    res.json({ ok: true, ingress: result });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// DELETE /api/network/ingresses/:namespace/:name (admin+)
router.delete('/ingresses/:namespace/:name', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = req.params['namespace'] as string;
  const name = req.params['name'] as string;
  try {
    await kubeClient.deleteIngress(namespace, name);
    logger.info(`[network] Deleted ingress ${name} in ${namespace}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// ── Services ─────────────────────────────────────────────────────────────────

// GET /api/network/services?namespace=X
router.get('/services', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const services = await kubeClient.listServicesWithHealth(namespace);
    res.json({ services, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/network/services — create (admin+)
router.post('/services', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, body } = req.body as { namespace: string; body: k8s.V1Service };
  if (!namespace || !body) { res.status(400).json({ error: 'namespace and body are required' }); return; }
  try {
    const result = await kubeClient.createService(namespace, body);
    logger.info(`[network] Created service ${body.metadata?.name} in ${namespace}`);
    res.json({ ok: true, service: result });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// PUT /api/network/services/:namespace/:name — update (admin+)
router.put('/services/:namespace/:name', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = req.params['namespace'] as string;
  const name = req.params['name'] as string;
  const { body } = req.body as { body: k8s.V1Service };
  if (!body) { res.status(400).json({ error: 'body is required' }); return; }
  try {
    const result = await kubeClient.updateService(namespace, name, body);
    logger.info(`[network] Updated service ${name} in ${namespace}`);
    res.json({ ok: true, service: result });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// DELETE /api/network/services/:namespace/:name (admin+)
router.delete('/services/:namespace/:name', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = req.params['namespace'] as string;
  const name = req.params['name'] as string;
  try {
    await kubeClient.deleteService(namespace, name);
    logger.info(`[network] Deleted service ${name} in ${namespace}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e?.statusCode ?? 500).json({ error: e?.message ?? String(e) });
  }
});

// ── Network Policies ─────────────────────────────────────────────────────────

// GET /api/network/policies?namespace=X
router.get('/policies', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const policies = await kubeClient.listNetworkPolicies(namespace);
    res.json({ policies, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
