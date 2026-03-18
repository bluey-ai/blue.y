// @premium — BlueOnion internal only. BLY-84
import { Router, Request, Response } from 'express';
import {
  createOpsIssue, listOpsIssues, getOpsIssue,
  updateOpsIssueStatus, assignOpsIssue,
  addOpsIssueComment, listOpsIssueComments,
  listOpsIssueTimeline, opsIssueStats,
} from '../db';
import type { IssueStatus, IssueSeverity } from '../db';

const router = Router();

const VALID_STATUSES: IssueStatus[]   = ['open', 'acknowledged', 'in_progress', 'needs_review', 'resolved', 'wont_fix'];
const VALID_SEVERITIES: IssueSeverity[] = ['low', 'medium', 'high', 'critical'];
const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, developer: 1.5, viewer: 1 };

function hasRole(req: Request, minRole: string): boolean {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 99);
}

// GET /api/issues — list issues with optional filters
router.get('/', (req: Request, res: Response) => {
  const status   = req.query.status   as string | undefined;
  const severity = req.query.severity as string | undefined;
  const limit    = Math.min(parseInt((req.query.limit as string) || '200', 10) || 200, 500);

  const issues = listOpsIssues({ status, severity, limit });
  const stats  = opsIssueStats();
  res.json({ issues, stats, count: issues.length });
});

// POST /api/issues — raise a new issue (all roles)
router.post('/', (req: Request, res: Response) => {
  const user = (req as any).adminUser;
  const { title, description, severity, source_type, source_name, source_namespace, ai_diagnosis } = req.body ?? {};

  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
  if (severity && !VALID_SEVERITIES.includes(severity)) { res.status(400).json({ error: 'Invalid severity' }); return; }

  const issue = createOpsIssue({
    title:            title.trim(),
    description:      (description ?? '').trim(),
    severity:         severity ?? 'medium',
    source_type:      source_type ?? 'manual',
    source_name:      source_name ?? '',
    source_namespace: source_namespace ?? '',
    raised_by_id:     user?.sub ?? '',
    raised_by_name:   user?.name ?? '',
    ai_diagnosis,
  });

  res.status(201).json(issue);
});

// GET /api/issues/stats — summary counts
router.get('/stats', (_req: Request, res: Response) => {
  res.json(opsIssueStats());
});

// GET /api/issues/:id — issue detail + comments + timeline
router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const issue = getOpsIssue(id);
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }

  const comments = listOpsIssueComments(id);
  const timeline = listOpsIssueTimeline(id);
  res.json({ issue, comments, timeline });
});

// PATCH /api/issues/:id/status — update status (admin+)
router.patch('/:id/status', (req: Request, res: Response) => {
  if (!hasRole(req, 'admin')) { res.status(403).json({ error: 'Requires admin role or higher' }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const { status, resolution_notes } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) { res.status(400).json({ error: 'Invalid status' }); return; }
  if (['resolved', 'wont_fix'].includes(status) && !resolution_notes?.trim()) {
    res.status(400).json({ error: 'resolution_notes required when closing an issue' }); return;
  }

  const user = (req as any).adminUser;
  const ok   = updateOpsIssueStatus(id, status, user?.sub ?? '', user?.name ?? '', resolution_notes?.trim());
  if (!ok) { res.status(404).json({ error: 'Issue not found' }); return; }

  const issue    = getOpsIssue(id);
  const timeline = listOpsIssueTimeline(id);
  res.json({ issue, timeline });
});

// POST /api/issues/:id/assign — assign to self (admin+)
router.post('/:id/assign', (req: Request, res: Response) => {
  if (!hasRole(req, 'admin')) { res.status(403).json({ error: 'Requires admin role or higher' }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const user = (req as any).adminUser;
  const ok   = assignOpsIssue(id, user?.sub ?? '', user?.name ?? '', user?.sub ?? '', user?.name ?? '');
  if (!ok) { res.status(404).json({ error: 'Issue not found' }); return; }

  res.json({ ok: true });
});

// POST /api/issues/:id/comments — add comment (all roles)
router.post('/:id/comments', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const { content } = req.body ?? {};
  if (!content?.trim()) { res.status(400).json({ error: 'content is required' }); return; }

  const issue = getOpsIssue(id);
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }

  const user    = (req as any).adminUser;
  const comment = addOpsIssueComment(id, user?.sub ?? '', user?.name ?? '', content.trim());
  res.status(201).json(comment);
});

export default router;
