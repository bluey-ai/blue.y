// @premium — BlueOnion internal only. (BLY-50)
import { Router, Request, Response } from 'express';
import {
  listSsoInvites, getSsoInvite, createSsoInvite, revokeSsoInvite,
  changeSsoInviteRole, countActiveInvites,
} from '../db';
import type { AdminRole } from '../db';

const router = Router();

const SEAT_LIMIT = parseInt(process.env.ADMIN_SEAT_LIMIT || '10', 10);
const VALID_ROLES: AdminRole[] = ['admin', 'viewer']; // superadmin cannot be invited via SSO

// GET /api/invites — list all SSO invites
router.get('/', (_req: Request, res: Response) => {
  const invites = listSsoInvites();
  const activeCount = invites.filter(i => i.status === 'active').length;
  res.json({ invites, activeCount, seatLimit: SEAT_LIMIT });
});

// POST /api/invites — create a new invite
// Body: { email, role: 'admin'|'viewer' }
router.post('/', (req: Request, res: Response) => {
  const { email, role } = req.body ?? {};
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (!role || !VALID_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    return;
  }

  // Check seat limit
  const activeCount = countActiveInvites();
  if (activeCount >= SEAT_LIMIT) {
    res.status(402).json({
      error: `Seat limit reached (${SEAT_LIMIT} active). Upgrade your license to invite more users.`,
      code: 'SEAT_LIMIT_REACHED',
      seatLimit: SEAT_LIMIT,
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

  const invitedBy = (req as any).adminUser?.sub ?? 'system';
  const invite = createSsoInvite(email, role as AdminRole, invitedBy);
  res.status(201).json({ ok: true, invite });
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
