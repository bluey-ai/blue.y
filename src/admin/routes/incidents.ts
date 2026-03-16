// @premium — BlueOnion internal only.
import { Router, Request, Response } from 'express';
import { queryIncidents, getIncidentById, incidentStats } from '../db';

const router = Router();

// GET /api/incidents?limit=50&severity=critical&namespace=prod&monitor=pods&search=OOM
router.get('/', (req: Request, res: Response) => {
  const limit     = Math.min(parseInt(req.query.limit     as string || '50', 10), 500);
  const severity  = req.query.severity  as string | undefined;
  const namespace = req.query.namespace as string | undefined;
  const monitor   = req.query.monitor   as string | undefined;
  const search    = req.query.search    as string | undefined;

  const incidents = queryIncidents({ limit, severity, namespace, monitor, search });
  const stats = incidentStats();
  res.json({ incidents, stats, count: incidents.length });
});

// GET /api/incidents/stats
router.get('/stats', (_req: Request, res: Response) => {
  res.json(incidentStats());
});

// GET /api/incidents/:id
router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const incident = getIncidentById(id);
  if (!incident) { res.status(404).json({ error: 'Incident not found' }); return; }

  res.json(incident);
});

export default router;
