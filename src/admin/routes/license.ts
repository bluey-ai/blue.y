// @premium — BlueOnion internal only. (BLY-61)
import { Router, Request, Response } from 'express';
import { getActiveLicense, verifyLicenseKey } from '../license';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/license — current license info
router.get('/', (_req: Request, res: Response) => {
  const lic = getActiveLicense();
  res.json({
    plan:      lic.plan,
    seats:     lic.seats,
    expires:   lic.expires || null,
    customer:  lic.customer ?? null,
    hasCustomKey: !!process.env.ADMIN_LICENSE_KEY,
  });
});

// POST /api/license/verify — verify and apply a new license key
// Body: { key: '<license jwt>' }
router.post('/verify', (req: Request, res: Response) => {
  const { key } = req.body ?? {};
  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  const result = verifyLicenseKey(key);
  if (!result) {
    res.status(422).json({ error: 'Invalid or expired license key' });
    return;
  }
  logger.info(`[license] License key verified via dashboard: ${result.plan}, ${result.seats} seats`);
  res.json({ ok: true, plan: result.plan, seats: result.seats, expires: result.expires || null });
});

export default router;
