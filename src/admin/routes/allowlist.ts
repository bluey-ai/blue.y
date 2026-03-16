// @premium — BlueOnion internal only. (BLY-55)
import { Router, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';
import { listAllowlist, addToAllowlist, removeFromAllowlist } from '../db';

const router = Router();

function parseRequestIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return req.socket.remoteAddress ?? '127.0.0.1';
}

// GET /api/allowlist — list all entries
router.get('/', (_req: Request, res: Response) => {
  res.json({ entries: listAllowlist() });
});

// GET /api/allowlist/myip — return the caller's detected IP (for "Add my IP" button)
router.get('/myip', (req: Request, res: Response) => {
  res.json({ ip: parseRequestIp(req) });
});

// POST /api/allowlist — add a CIDR entry
// Body: { cidr: '1.2.3.4/32', label: 'My office' }
// Omit /prefix to auto-add /32 (single IP)
router.post('/', (req: Request, res: Response) => {
  let { cidr, label } = req.body ?? {};
  if (!cidr || typeof cidr !== 'string') {
    res.status(400).json({ error: 'cidr is required' });
    return;
  }
  // Auto-append /32 if no prefix given
  if (!cidr.includes('/')) cidr = `${cidr}/32`;

  try {
    ipaddr.parseCIDR(cidr); // validate format
  } catch {
    res.status(400).json({ error: `Invalid CIDR: ${cidr}` });
    return;
  }

  const addedBy = (req as any).adminUser?.sub ?? 'system';
  addToAllowlist(cidr, label ?? '', addedBy);
  res.status(201).json({ ok: true, cidr });
});

// DELETE /api/allowlist/:id — remove by row id
router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'id must be a number' }); return; }
  const ok = removeFromAllowlist(id);
  if (!ok) { res.status(404).json({ error: 'Entry not found' }); return; }
  res.json({ ok: true });
});

export default router;
