// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { getAdminUsers, addAdminUser, removeAdminUser } from '../config-watcher';

const router = Router();

// GET /api/users — list all admin users
router.get('/', (_req: Request, res: Response) => {
  const users = getAdminUsers().map((u, i) => ({ id: i, ...u }));
  res.json({ users, count: users.length });
});

// POST /api/users — add an admin user
// Body: { platform: 'telegram'|'slack'|'teams', userId: '123456', displayName: 'Jane Doe' }
router.post('/', async (req: Request, res: Response) => {
  const { platform, userId, displayName } = req.body ?? {};
  if (!platform || !userId || !displayName) {
    res.status(400).json({ error: 'platform, userId, and displayName are required' });
    return;
  }
  if (!['telegram', 'slack', 'teams', 'whatsapp'].includes(platform)) {
    res.status(400).json({ error: 'platform must be telegram, slack, teams, or whatsapp' });
    return;
  }
  try {
    await addAdminUser({ platform, userId: String(userId), displayName });
    res.status(201).json({ ok: true, user: { platform, userId: String(userId), displayName } });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// DELETE /api/users/:platform/:userId — remove an admin user
router.delete('/:platform/:userId', async (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  const userId   = req.params.userId   as string;
  try {
    const removed = await removeAdminUser(platform, userId);
    if (!removed) { res.status(404).json({ error: 'User not found in whitelist' }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
