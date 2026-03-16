// @premium — BlueOnion internal only. (BLY-50/61)
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import {
  listSsoInvites, getSsoInvite, createSsoInvite, revokeSsoInvite,
  changeSsoInviteRole, countActiveInvites,
} from '../db';
import type { AdminRole } from '../db';
import { getAuthorisedSeats } from '../license';
import { EmailClient } from '../../clients/email';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const emailClient = new EmailClient();

// Read blue-y-config ConfigMap — returns {} if not found or on error
async function readConfigMap(): Promise<Record<string, string>> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const namespace = config.kube.namespaces[0] || 'prod';
    const cm = await api.readNamespacedConfigMap({ name: 'blue-y-config', namespace });
    return cm.data ?? {};
  } catch {
    return {};
  }
}

const router = Router();

const VALID_ROLES: AdminRole[] = ['admin', 'viewer']; // superadmin cannot be invited via SSO

// GET /api/invites — list all SSO invites
router.get('/', (_req: Request, res: Response) => {
  const invites = listSsoInvites();
  const activeCount = invites.filter(i => i.status === 'active').length;
  const seatLimit = getAuthorisedSeats();
  res.json({ invites, activeCount, seatLimit });
});

// POST /api/invites — create a new invite
// Body: { email, role: 'admin'|'viewer', sendEmail?: boolean }
router.post('/', async (req: Request, res: Response) => {
  const { email, role, sendEmail } = req.body ?? {};
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (!role || !VALID_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    return;
  }

  // Check seat limit against active license (BLY-61)
  const seatLimit = getAuthorisedSeats();
  const activeCount = countActiveInvites();
  if (activeCount >= seatLimit) {
    res.status(402).json({
      error: `Seat limit reached (${seatLimit} active). Upgrade your license to invite more users ($2.99/user/month).`,
      code: 'SEAT_LIMIT_REACHED',
      seatLimit,
      activeCount,
    });
    return;
  }

  // Check for existing invite
  const existing = getSsoInvite(email);
  if (existing && existing.status === 'active') {
    res.status(409).json({ error: 'An active invite already exists for this email' });
    return;
  }

  const adminUser = (req as any).adminUser;
  const invitedBy = adminUser?.sub ?? 'system';
  const invite = createSsoInvite(email, role as AdminRole, invitedBy);

  // BLY-56: optionally send invite email via SES
  let emailWarning: string | undefined;
  if (sendEmail === true) {
    try {
      const cfg = await readConfigMap();
      const orgName    = cfg['email.org_name'] || 'BLUE.Y';
      const fromName   = cfg['email.template.invite.from_name'] || 'BLUE.Y Admin';
      const welcomeMsg = cfg['email.template.invite.welcome_msg'] || '';
      const footerMsg  = cfg['email.template.invite.footer_msg'] || '';
      const rawSubject = cfg['email.template.invite.subject'] || "You've been invited to {{org_name}} BLUE.Y Dashboard";
      const subject    = rawSubject.replace(/\{\{org_name\}\}/g, orgName);
      const dashboardUrl = (config.admin.host || '') + '/admin/';
      const inviteeName  = email.split('@')[0]; // best guess from email local part
      const inviterName  = adminUser?.name || 'Your administrator';

      const html = emailClient.buildInviteHtml({ inviteeName, inviterName, role, dashboardUrl, orgName, welcomeMsg, footerMsg });
      const sent = await emailClient.send(email, fromName, subject, html);
      if (!sent) emailWarning = 'Invite created but email delivery failed — check SES/SMTP config.';
    } catch (err: any) {
      logger.error(`[invites] Email send failed for ${email}: ${err?.message}`);
      emailWarning = 'Invite created but email delivery failed — check SES/SMTP config.';
    }
  }

  res.status(201).json({ ok: true, invite, ...(emailWarning ? { warning: emailWarning } : {}) });
});

// PATCH /api/invites/:email/role — change role of active invite
router.patch('/:email/role', (req: Request, res: Response) => {
  const email = decodeURIComponent(req.params.email as string);
  const { role } = req.body ?? {};
  if (!role || !VALID_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    return;
  }
  const ok = changeSsoInviteRole(email, role as AdminRole);
  if (!ok) { res.status(404).json({ error: 'No active invite found for this email' }); return; }
  res.json({ ok: true });
});

// DELETE /api/invites/:email — revoke invite
router.delete('/:email', (req: Request, res: Response) => {
  const email = decodeURIComponent(req.params.email as string);
  const ok = revokeSsoInvite(email);
  if (!ok) { res.status(404).json({ error: 'Invite not found' }); return; }
  res.json({ ok: true });
});

export default router;
