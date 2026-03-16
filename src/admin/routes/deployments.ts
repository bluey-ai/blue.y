// @premium — BlueOnion internal only.
import { Router, Request, Response, NextFunction } from 'express';
import { KubeClient } from '../../clients/kube';
import { logger } from '../../utils/logger';
import {
  createApproval, waitForApproval, formatApprovalMessage,
  approvalCallbackData, getSuperAdminTelegramId, listPendingApprovals,
} from '../approvals';

const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, viewer: 1 };
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if ((ROLE_RANK[role] ?? 0) >= 2) { next(); return; }
  res.status(403).json({ error: 'Requires admin role or higher' });
}

let kubeClient: KubeClient | null = null;
// Telegram sender injected by main.ts (needed to send approval requests to SuperAdmin)
let telegramSend: ((msg: string, chatId?: string, opts?: Record<string, unknown>) => Promise<unknown>) | null = null;

export function setDeploymentsKubeClient(kube: KubeClient): void {
  kubeClient = kube;
}
export function setDeploymentsTelegramSend(fn: typeof telegramSend): void {
  telegramSend = fn;
}

const router = Router();

// GET /api/deployments/:namespace/:name/pods — list pods for a specific deployment (admin+)
router.get('/:namespace/:name/pods', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const namespace = req.params.namespace as string;
  const name      = req.params.name as string;
  try {
    const allPods = await kubeClient.getPods(namespace);
    // Match pods owned by this deployment (name prefix match on ReplicaSet-managed pods)
    const pods = allPods.filter(p => p.name.startsWith(name + '-') && !p.isJobPod);
    res.json({ pods, namespace, deployment: name });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

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

// GET /api/deployments/approvals — list pending approvals (superadmin only via role check in index.ts)
router.get('/approvals', (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role !== 'superadmin') { res.status(403).json({ error: 'Requires superadmin' }); return; }
  res.json({ approvals: listPendingApprovals() });
});

// POST /api/deployments/restart — rolling restart (admin+)
// BLY-62: Admin role → creates approval request → waits for SuperAdmin via SSE
//          SuperAdmin role → executes immediately
router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
  if (!kubeClient) { res.status(503).json({ error: 'Kube client not available' }); return; }
  const { namespace, deployment } = req.body ?? {};
  if (!namespace || !deployment) {
    res.status(400).json({ error: 'namespace and deployment are required' });
    return;
  }

  const role: string = (req as any).adminUser?.role ?? 'viewer';
  const requestedBy: string = (req as any).adminUser?.name ?? 'Admin';

  // SuperAdmin: execute immediately
  if (role === 'superadmin') {
    try {
      const ok = await kubeClient.restartDeployment(namespace, deployment);
      if (ok) {
        logger.info(`[admin] Restarted ${namespace}/${deployment} by SuperAdmin ${requestedBy}`);
        res.json({ ok: true, message: `Rolling restart triggered for ${deployment}` });
      } else {
        res.status(500).json({ error: 'Restart failed — check deployment name and namespace' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
    return;
  }

  // Admin: create approval request
  const approval = createApproval('restart', namespace, deployment, requestedBy);
  await sendApprovalToTelegram(approval);
  res.status(202).json({
    ok: false,
    requiresApproval: true,
    approvalId: approval.id,
    message: `Restart request sent to SuperAdmin for approval.`,
  });
});

// POST /api/deployments/scale (admin+)
router.post('/scale', requireAdmin, async (req: Request, res: Response) => {
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

  const role: string = (req as any).adminUser?.role ?? 'viewer';
  const requestedBy: string = (req as any).adminUser?.name ?? 'Admin';

  // SuperAdmin: execute immediately
  if (role === 'superadmin') {
    try {
      const ok = await kubeClient.scaleDeployment(namespace, deployment, r);
      if (ok) {
        logger.info(`[admin] Scaled ${namespace}/${deployment} → ${r} by SuperAdmin ${requestedBy}`);
        res.json({ ok: true, message: `Scaled ${deployment} to ${r} replica${r !== 1 ? 's' : ''}` });
      } else {
        res.status(500).json({ error: 'Scale failed' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
    return;
  }

  // Admin: create approval request
  const approval = createApproval('scale', namespace, deployment, requestedBy, r);
  await sendApprovalToTelegram(approval);
  res.status(202).json({
    ok: false,
    requiresApproval: true,
    approvalId: approval.id,
    message: `Scale request sent to SuperAdmin for approval.`,
  });
});

// GET /api/deployments/approval/:id/wait — SSE stream that resolves when approval is decided
// Dashboard polls this to show live status of pending approval
router.get('/approval/:id/wait', (req: Request, res: Response) => {
  const id = req.params.id as string;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  waitForApproval(id, (status) => {
    res.write(`event: decision\ndata: ${JSON.stringify({ approvalId: id, status })}\n\n`);
    clearInterval(heartbeat);
    res.end();
  });

  req.on('close', () => { clearInterval(heartbeat); });
});

async function sendApprovalToTelegram(approval: import('../approvals').PendingApproval): Promise<void> {
  if (!telegramSend) return;
  const superAdminId = getSuperAdminTelegramId();
  if (!superAdminId) {
    logger.warn('[approvals] No SuperAdmin Telegram ID configured — approval request not sent');
    return;
  }
  const text = formatApprovalMessage(approval);
  const inlineKeyboard = {
    inline_keyboard: [[
      { text: '✅ Approve',  callback_data: approvalCallbackData(approval.id, 'approve') },
      { text: '❌ Reject',   callback_data: approvalCallbackData(approval.id, 'reject')  },
    ]],
  };
  try {
    await telegramSend(text, superAdminId, { reply_markup: JSON.stringify(inlineKeyboard) });
    logger.info(`[approvals] Approval request ${approval.id} sent to SuperAdmin (${superAdminId})`);
  } catch (e: any) {
    logger.warn(`[approvals] Failed to send Telegram approval request: ${e?.message}`);
  }
}

export default router;
