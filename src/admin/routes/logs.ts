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

// POST /api/logs/diagnose — AI pod diagnosis (BLY-71)
router.post('/diagnose', async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, pod } = req.body ?? {};
  if (!namespace || !pod) { res.status(400).json({ error: 'namespace and pod are required' }); return; }

  let logsText = '';
  let podState = '';

  try {
    const raw = await kubeClient.getPodLogs(namespace, pod, 100);
    logsText = sanitizeForAI(raw.slice(0, 8000));
  } catch { logsText = '(logs unavailable — pod may not have started)'; }

  try {
    const detail = await kubeClient.getPodDetail(namespace, pod);
    if (detail) {
      podState = sanitizeForAI(JSON.stringify({
        phase: detail.pod.phase,
        containers: detail.containers.map((c: any) => ({
          name: c.name, state: c.state, reason: c.reason,
          restartCount: c.restartCount, image: c.image,
        })),
      }));
    }
  } catch { podState = '(pod detail unavailable)'; }

  const ai = new BedrockClient();
  const prompt = `You are a Kubernetes expert diagnosing a failing pod. Analyze all context and return a structured diagnosis.

Pod: ${pod}
Namespace: ${namespace}

=== POD STATE ===
${podState}

=== RECENT LOGS (last 100 lines) ===
${logsText}
=== END LOGS ===

Respond with ONLY valid JSON:
{
  "rootCause": "2-4 sentence plain English explanation. No K8s jargon — explain it like talking to a developer.",
  "confidence": "high|medium|low",
  "severity": "critical|warning|info",
  "suggestions": [
    { "rank": 1, "action": "Short title", "description": "What to do and why", "command": "rebuild|restart|scale|check_logs|check_config" }
  ]
}

Confidence: "high" = root cause obvious from logs/events, "medium" = inferred, "low" = insufficient data.
Max 4 suggestions ranked by likelihood to fix. Only include "command" if it maps to an available action (rebuild, restart, scale, check_logs, check_config).`;

  try {
    const raw = await ai.analyzeRaw(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      rootCause: 'Unable to determine root cause from available data.',
      confidence: 'low', severity: 'warning', suggestions: [],
    };
    res.json({ diagnosis: { ...parsed, analyzedAt: new Date().toISOString() } });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/logs/nl-search — translate natural language query to filter keywords (BLY-72)
router.post('/nl-search', async (req: Request, res: Response) => {
  const { query } = req.body ?? {};
  if (!query || typeof query !== 'string') { res.status(400).json({ error: 'query is required' }); return; }

  const ai = new BedrockClient();
  const prompt = `Convert this log search query to a short list of keywords for filtering log lines.

Query: "${sanitizeForAI(query.slice(0, 200))}"

Respond with ONLY valid JSON:
{"keywords": ["keyword1", "keyword2"]}

Rules:
- 1-4 specific keywords that match relevant log lines
- Include error codes, status codes, package names where relevant
- For time-based queries, focus on error/severity terms

Examples:
- "show redis errors" → {"keywords": ["redis", "connection refused", "ECONNREFUSED"]}
- "auth failures" → {"keywords": ["401", "unauthorized", "invalid token"]}
- "what caused the crash" → {"keywords": ["fatal", "exception", "panic", "SIGKILL"]}`;

  try {
    const raw = await ai.analyzeRaw(prompt);
    const m = raw.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { keywords: [query] });
  } catch {
    res.json({ keywords: [query] }); // fallback: use raw query as keyword
  }
});

export default router;
