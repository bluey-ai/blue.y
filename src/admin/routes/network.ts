// @premium — BlueOnion internal only.
import { Router, Request, Response, NextFunction } from 'express';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { KubeClient } from '../../clients/kube';
import { BedrockClient } from '../../clients/bedrock';
import { logger } from '../../utils/logger';
import { sanitizeForAI } from '../../utils/sanitize';
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

// ── ALB Info + CloudWatch Metrics ────────────────────────────────────────────

// Parse ALB CloudWatch dimension from ELB hostname
// e.g. k8s-produnifiedlb-93fcf39fe0-1535221539.ap-southeast-1.elb.amazonaws.com
//   → { region: 'ap-southeast-1', lbName: 'k8s-produnifiedlb-93fcf39fe0', lbId: '1535221539' }
function parseAlbHostname(hostname: string): { region: string; lbName: string; lbId: string; cwDimension: string } | null {
  try {
    const parts = hostname.split('.');
    if (parts.length < 4) return null;
    const region = parts[1];
    const namePart = parts[0];
    const lastDash = namePart.lastIndexOf('-');
    if (lastDash < 0) return null;
    const lbName = namePart.substring(0, lastDash);
    const lbId   = namePart.substring(lastDash + 1);
    // Try both app/ (ALB) and net/ (NLB) prefixes — CloudWatch query will return empty for wrong one
    const cwDimension = `app/${lbName}/${lbId}`;
    return { region, lbName, lbId, cwDimension };
  } catch { return null; }
}

// GET /api/network/alb?namespace=X — ALB info from ingress addresses + CloudWatch metrics
router.get('/alb', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const ingresses = await kubeClient.listIngresses(namespace);

    // Collect unique ALB hostnames from ingress .status.loadBalancer.ingress
    const seen = new Map<string, { hostname: string; usedBy: string[] }>();
    for (const ing of ingresses) {
      const raw = ing.raw as any;
      const lbItems: any[] = raw?.status?.loadBalancer?.ingress || [];
      for (const lb of lbItems) {
        const h = lb.hostname || lb.ip || '';
        if (!h) continue;
        if (!seen.has(h)) seen.set(h, { hostname: h, usedBy: [] });
        seen.get(h)!.usedBy.push(ing.name);
      }
    }

    const albList = Array.from(seen.values()).map(({ hostname, usedBy }) => {
      const parsed = parseAlbHostname(hostname);
      return { hostname, usedBy, ...(parsed ?? { region: 'ap-southeast-1', lbName: hostname, lbId: '', cwDimension: '' }) };
    });

    // Query CloudWatch for the last 1 hour of ALB metrics (best-effort, silent failure)
    const metricsMap: Record<string, Record<string, number | null>> = {};
    const firstAlb = albList.find(a => a.cwDimension);
    if (firstAlb) {
      try {
        const cw = new CloudWatchClient({ region: firstAlb.region });
        const now  = new Date();
        const from = new Date(now.getTime() - 3600_000);

        const queries = albList.filter(a => a.cwDimension).flatMap((alb, i) => [
          { Id: `req${i}`,     MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount',              Dimensions: [{ Name: 'LoadBalancer', Value: alb.cwDimension }] }, Period: 3600, Stat: 'Sum'     } },
          { Id: `err5${i}`,    MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'HTTPCode_Target_5XX_Count',  Dimensions: [{ Name: 'LoadBalancer', Value: alb.cwDimension }] }, Period: 3600, Stat: 'Sum'     } },
          { Id: `err4${i}`,    MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'HTTPCode_Target_4XX_Count',  Dimensions: [{ Name: 'LoadBalancer', Value: alb.cwDimension }] }, Period: 3600, Stat: 'Sum'     } },
          { Id: `latency${i}`, MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'TargetResponseTime',         Dimensions: [{ Name: 'LoadBalancer', Value: alb.cwDimension }] }, Period: 3600, Stat: 'Average' } },
        ]);

        const result = await cw.send(new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: from,
          EndTime: now,
        }));

        albList.filter(a => a.cwDimension).forEach((_, i) => {
          metricsMap[i] = {};
          for (const md of result.MetricDataResults ?? []) {
            const v = md.Values && md.Values.length > 0 ? md.Values[md.Values.length - 1] : null;
            if (md.Id === `req${i}`)     metricsMap[i].requestCount = v;
            if (md.Id === `err5${i}`)    metricsMap[i].errors5xx    = v;
            if (md.Id === `err4${i}`)    metricsMap[i].errors4xx    = v;
            if (md.Id === `latency${i}`) metricsMap[i].latencyMs    = v != null ? Math.round(v * 1000) : null;
          }
          if (metricsMap[i].requestCount && metricsMap[i].errors5xx) {
            const pct = (metricsMap[i].errors5xx! / metricsMap[i].requestCount!) * 100;
            metricsMap[i].errorRate5xx = Math.round(pct * 100) / 100;
          }
        });
      } catch (cwErr) {
        logger.warn('[network] CloudWatch metrics unavailable:', (cwErr as any)?.message);
      }
    }

    const albs = albList.map((alb, i) => ({
      hostname:     alb.hostname,
      lbName:       alb.lbName,
      region:       alb.region,
      usedBy:       alb.usedBy,
      requestCount: metricsMap[i]?.requestCount ?? null,
      errors5xx:    metricsMap[i]?.errors5xx    ?? null,
      errors4xx:    metricsMap[i]?.errors4xx    ?? null,
      latencyMs:    metricsMap[i]?.latencyMs    ?? null,
      errorRate5xx: metricsMap[i]?.errorRate5xx ?? null,
    }));

    res.json({ albs, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── AI Route Diagnostics (BLY-78 Tool 1) ─────────────────────────────────────

// POST /api/network/ai/diagnose-route
router.post('/ai/diagnose-route', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { ingressName, namespace } = req.body as { ingressName: string; namespace: string };
  if (!ingressName || !namespace) { res.status(400).json({ error: 'ingressName and namespace required' }); return; }

  try {
    const ai = new BedrockClient();

    // Gather full context
    const [ingresses, services, events] = await Promise.all([
      kubeClient.listIngresses(namespace),
      kubeClient.listServicesWithHealth(namespace).catch(() => []),
      kubeClient.getEvents(namespace).catch(() => ''),
    ]);

    const ingress = ingresses.find(i => i.name === ingressName);
    if (!ingress) { res.status(404).json({ error: `Ingress ${ingressName} not found` }); return; }

    // Build backend chain context
    const chains = ingress.rules.flatMap(rule =>
      rule.paths.map(p => {
        const svc = services.find(s => s.name === p.serviceName);
        return {
          host: rule.host,
          path: p.path,
          backend: `${p.serviceName}:${p.servicePort}`,
          endpointsReady: svc?.endpointsReady ?? 0,
          endpointsTotal: svc?.endpointsTotal ?? 0,
          serviceExists:  !!svc,
          serviceType:    svc?.type ?? 'missing',
          selector:       svc?.selector ?? {},
          isDead:         svc?.isDead ?? true,
        };
      })
    );

    const prompt = `You are a Kubernetes networking expert. Diagnose why this ingress route is unhealthy.

INGRESS: ${ingressName} (namespace: ${namespace})
Class: ${ingress.ingressClass ?? 'none'} | TLS: ${ingress.tlsStatus}
Annotations: ${sanitizeForAI(JSON.stringify(ingress.annotations))}

BACKEND CHAIN:
${sanitizeForAI(JSON.stringify(chains, null, 2))}

RECENT EVENTS (last 3000 chars):
${sanitizeForAI(events.slice(-3000))}

Respond with ONLY valid JSON, no markdown:
{
  "rootCause": "single clear sentence",
  "confidence": "high|medium|low",
  "breakpoint": "ingress|service|endpoints|pods|tls|dns|none",
  "severity": "critical|warning|info",
  "suggestions": [
    { "rank": 1, "action": "what to do", "command": "kubectl ... (or empty string)" }
  ]
}`;

    const raw = await ai.analyzeRaw(prompt);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      const diagnosis = JSON.parse(cleaned);
      logger.info(`[network] AI diagnosed ${ingressName}: ${diagnosis.rootCause}`);
      res.json({ ok: true, diagnosis, ingressName, namespace });
    } catch {
      res.json({ ok: true, diagnosis: { rootCause: cleaned, confidence: 'low', severity: 'warning', breakpoint: 'none', suggestions: [] }, ingressName, namespace });
    }
  } catch (e: any) {
    logger.error('[network] AI diagnose error:', e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
