// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { PassThrough } from 'stream';
import readline from 'readline';
import { KubeClient } from '../../clients/kube';
import { BedrockClient } from '../../clients/bedrock';
import { sanitizeForAI } from '../../utils/sanitize';
import { logger } from '../../utils/logger';

let kubeClient: KubeClient | null = null;

export function setLogsKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}

const router = Router();

// GET /api/logs/pods?namespace=X — list pods with their container names
router.get('/pods', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  try {
    const pods = await kubeClient.getPods(namespace);
    res.json({
      pods: pods.map(p => ({
        name: p.name,
        namespace: p.namespace,
        status: p.status,
        ready: p.ready,
        containers: p.containers.map(c => c.name),
      })),
      namespace,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/logs/fetch?namespace=X&pod=Y&container=Z&lines=500 — bulk fetch (for export / AI)
router.get('/fetch', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  const pod = req.query.pod as string;
  const lines = Math.min(parseInt((req.query.lines as string) || '500', 10), 2000);
  if (!pod) { res.status(400).json({ error: 'pod is required' }); return; }
  try {
    const raw = await kubeClient.getPodLogs(namespace, pod, lines);
    const lineArray = raw.split('\n').filter(Boolean);
    res.json({ lines: lineArray, pod, namespace });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/logs/stream?namespace=X&pod=Y&container=Z&tail=200 — SSE live log tail
router.get('/stream', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = (req.query.namespace as string) || 'prod';
  const pod = req.query.pod as string;
  const container = (req.query.container as string) || '';
  const tail = Math.min(parseInt((req.query.tail as string) || '200', 10), 1000);

  if (!pod) { res.status(400).json({ error: 'pod is required' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const logStream = new PassThrough();
  const rl = readline.createInterface({ input: logStream, crlfDelay: Infinity });

  rl.on('line', (line: string) => {
    if (line.trim()) {
      res.write(`event: log\ndata: ${line}\n\n`);
    }
  });

  let k8sHandle: { abort: () => void } | null = null;
  try {
    k8sHandle = await kubeClient.streamPodLogs(namespace, pod, container, logStream, {
      tailLines: tail,
      follow: true,
      timestamps: false,
    });
  } catch (e: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message ?? 'Stream failed' })}\n\n`);
    res.end();
    return;
  }

  // Keep ALB connection alive through idle timeout
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    try { k8sHandle?.abort(); } catch { /* ignore */ }
    logStream.destroy();
    rl.close();
    logger.debug(`[admin/logs] Stream closed: ${namespace}/${pod}`);
  });
});

// POST /api/logs/analyze — AI root cause analysis on provided log text
router.post('/analyze', async (req: Request, res: Response) => {
  const { namespace, pod, logs } = req.body ?? {};
  if (!logs || typeof logs !== 'string') {
    res.status(400).json({ error: 'logs string is required' });
    return;
  }

  const logText = sanitizeForAI(logs.slice(0, 15000));
  const ai = new BedrockClient();

  const prompt = `You are a Kubernetes expert doing root cause analysis on pod logs.

Pod: ${pod || 'unknown'}
Namespace: ${namespace || 'unknown'}

=== LOGS ===
${logText}
=== END LOGS ===

Analyze these logs and respond with ONLY valid JSON:
{
  "severity": "info|warning|critical",
  "summary": "1-2 sentence overall assessment of log health",
  "rootCause": "2-4 sentence plain English root cause. What is wrong and why.",
  "issues": ["specific error pattern 1", "specific error pattern 2"],
  "recommendation": "Concise step-by-step fix or 'Logs look healthy, no action needed'"
}

Focus on: CrashLoopBackOff, OOMKilled, connection refused, JDBC timeouts, exceptions, stack traces, restart loops.
If logs look healthy with no errors, set severity: "info".`;

  try {
    const raw = await ai.analyzeRaw(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      severity: 'info', summary: raw, rootCause: '', issues: [], recommendation: '',
    };
    res.json({ analysis: parsed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
