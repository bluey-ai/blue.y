// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { getAdminUsers } from '../config-watcher';

const router = Router();

// GET /api/config — returns live config values (safe, non-secret subset)
router.get('/', (_req: Request, res: Response) => {
  res.json({
    adminUsers: getAdminUsers(),
    note: 'Admin user list reflects current ConfigMap state (hot-reloaded every 30s). Restart not required.',
  });
});

export default router;
