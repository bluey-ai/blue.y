// @premium — BlueOnion internal only.
// Server-Sent Events stream — pushes live cluster state every 5 seconds.
// Consumed by the BLY-36 React SPA for real-time dashboard updates.
import { Router, Request, Response } from 'express';
import { KubeClient } from '../../clients/kube';

let kubeClient: KubeClient | null = null;

export function setStreamKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}

const router = Router();

// GET /api/stream — SSE stream of cluster events
// Sends a JSON event every 5s: { type: 'cluster', pods: [...], nodes: [...], ts: '...' }
router.get('/', (req: Request, res: Response) => {
  if (!kubeClient) {
    res.status(503).json({ error: 'Kube client not available' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering
  res.flushHeaders();

  function sendEvent(eventType: string, data: unknown): void {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Send a heartbeat immediately so the browser knows the stream is alive
  sendEvent('connected', { ts: new Date().toISOString() });

  async function pushClusterState(): Promise<void> {
    if (!kubeClient) return;
    try {
      const [nodes, namespaces] = await Promise.all([
        kubeClient.getNodes(),
        kubeClient.getUserNamespaces(),
      ]);

      // Gather pods for all namespaces in parallel
      const podsByNs = await Promise.all(
        namespaces.map(async (ns) => ({ ns, pods: await kubeClient!.getPods(ns) }))
      );

      sendEvent('cluster', {
        ts: new Date().toISOString(),
        nodes,
        namespaces: podsByNs.map(({ ns, pods }) => ({
          namespace: ns,
          pods,
          healthy: pods.filter(p => p.status === 'Running' || p.status === 'Succeeded').length,
          unhealthy: pods.filter(p => p.status !== 'Running' && p.status !== 'Succeeded').length,
        })),
      });
    } catch (e: any) {
      sendEvent('error', { message: e?.message ?? String(e), ts: new Date().toISOString() });
    }
  }

  // Push immediately, then every 5s
  pushClusterState();
  const interval = setInterval(pushClusterState, 5_000);

  // Heartbeat every 30s to keep the connection alive through proxies/ALB idle timeout
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

export default router;
