// @premium — BlueOnion internal only. (BLY-62)
// Admin action approval workflow.
// When an Admin user triggers restart/scale, the action is held pending.
// A Telegram inline keyboard message is sent to the SuperAdmin (ADMIN_SUPERADMIN_TELEGRAM_ID).
// SuperAdmin approves or rejects. The result is broadcast via SSE to waiting dashboard clients.
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

export type ApprovalAction = 'restart' | 'scale';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingApproval {
  id:          string;    // short hex token used in callback_data
  action:      ApprovalAction;
  namespace:   string;
  deployment:  string;
  replicas?:   number;    // for scale
  requestedBy: string;    // display name of the Admin who requested
  requestedAt: number;    // unix ms
  status:      ApprovalStatus;
  telegramMsgId?: number; // message_id of the Telegram approval message (for editing on resolve)
}

// In-memory store — survives only the current process lifetime.
// A restart clears all pending approvals (acceptable; they expire in 10 min anyway).
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Registered SSE response callbacks for waiting dashboard clients (by approval id)
const sseListeners = new Map<string, Set<(status: ApprovalStatus) => void>>();

// Clean up expired approvals every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, approval] of pendingApprovals) {
    if (approval.status === 'pending' && now - approval.requestedAt > APPROVAL_TTL_MS) {
      approval.status = 'expired';
      notifyListeners(id, 'expired');
      logger.info(`[approvals] Approval ${id} expired (${approval.action} ${approval.namespace}/${approval.deployment})`);
      pendingApprovals.delete(id);
    }
  }
}, 60_000).unref();

function notifyListeners(id: string, status: ApprovalStatus): void {
  const listeners = sseListeners.get(id);
  if (listeners) {
    for (const cb of listeners) cb(status);
    sseListeners.delete(id);
  }
}

/** Create a new pending approval and return its ID. */
export function createApproval(
  action: ApprovalAction,
  namespace: string,
  deployment: string,
  requestedBy: string,
  replicas?: number,
): PendingApproval {
  const id = crypto.randomBytes(6).toString('hex'); // 12-char hex
  const approval: PendingApproval = {
    id, action, namespace, deployment, replicas,
    requestedBy, requestedAt: Date.now(), status: 'pending',
  };
  pendingApprovals.set(id, approval);
  logger.info(`[approvals] Created approval ${id}: ${action} ${namespace}/${deployment} by ${requestedBy}`);
  return approval;
}

export function getApproval(id: string): PendingApproval | undefined {
  return pendingApprovals.get(id);
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pendingApprovals.values()].filter(a => a.status === 'pending');
}

/** Resolve an approval (approve or reject). Returns false if not found or already resolved. */
export function resolveApproval(id: string, decision: 'approved' | 'rejected'): PendingApproval | null {
  const approval = pendingApprovals.get(id);
  if (!approval || approval.status !== 'pending') return null;
  approval.status = decision;
  notifyListeners(id, decision);
  logger.info(`[approvals] Approval ${id} ${decision}: ${approval.action} ${approval.namespace}/${approval.deployment}`);
  return approval;
}

/** Register an SSE listener for a specific approval. Called by the waiting dashboard. */
export function waitForApproval(id: string, callback: (status: ApprovalStatus) => void): void {
  if (!sseListeners.has(id)) sseListeners.set(id, new Set());
  sseListeners.get(id)!.add(callback);
}

/** Generate Telegram inline keyboard callback_data for this approval. */
export function approvalCallbackData(id: string, decision: 'approve' | 'reject'): string {
  return `approval:${decision}:${id}`;
}

/** Format the Telegram approval request message. */
export function formatApprovalMessage(approval: PendingApproval): string {
  const actionLabel = approval.action === 'restart'
    ? '🔄 Rolling Restart'
    : `⚖️ Scale → ${approval.replicas} replica${approval.replicas !== 1 ? 's' : ''}`;

  return (
    `⚠️ <b>Action Approval Required</b>\n\n` +
    `<b>Action:</b> ${actionLabel}\n` +
    `<b>Target:</b> <code>${approval.namespace}/${approval.deployment}</code>\n` +
    `<b>Requested by:</b> ${approval.requestedBy}\n\n` +
    `Approval ID: <code>${approval.id}</code>\n` +
    `⏱ Expires in 10 minutes`
  );
}

/** SuperAdmin Telegram ID for sending approval requests. */
export function getSuperAdminTelegramId(): string {
  return config.admin.superAdmin.telegramId;
}
