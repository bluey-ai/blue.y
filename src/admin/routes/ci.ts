// BLY-70 — Smart Rebuild: trigger CI pipeline via git push from pod
// Supports Bitbucket (x-token-auth) and GitHub (PAT).
// Tokens are configured via the Integrations page (CI/CD Providers section),
// stored in the blue-y-config ConfigMap. Falls back to BB_TOKEN env var for compat.
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const execFileAsync = promisify(execFile);

const CONFIG_MAP_NAME = 'blue-y-config';
const FALLBACK_WORKSPACE = 'blue-onion';

interface CiProviderConfig {
  provider: 'bitbucket' | 'github';
  token: string;
  workspace: string; // bitbucket workspace slug OR github org/user
  email?: string;   // bitbucket: Atlassian account email for Basic auth (email:token)
}

/** Read CI provider config from ConfigMap, falling back to env vars. */
async function resolveCiConfig(preferredProvider?: string): Promise<CiProviderConfig | null> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const namespace = config.kube.namespaces[0] || 'prod';

  let data: Record<string, string> = {};
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
    data = cm.data ?? {};
  } catch { /* ConfigMap not found — use env fallback */ }

  const bbToken     = data['ci.bitbucket.token']     || process.env.BB_TOKEN || '';
  const bbWorkspace = data['ci.bitbucket.workspace']  || FALLBACK_WORKSPACE;
  const bbEmail     = data['ci.bitbucket.email']      || process.env.BB_EMAIL || '';
  const ghToken     = data['ci.github.token']         || '';
  const ghOrg       = data['ci.github.org']           || '';

  if (preferredProvider === 'github' && ghToken && ghOrg) {
    return { provider: 'github', token: ghToken, workspace: ghOrg };
  }
  if (preferredProvider === 'bitbucket' && bbToken) {
    return { provider: 'bitbucket', token: bbToken, workspace: bbWorkspace, email: bbEmail };
  }
  // Auto-detect: Bitbucket first (existing deployments), then GitHub
  if (bbToken) return { provider: 'bitbucket', token: bbToken, workspace: bbWorkspace, email: bbEmail };
  if (ghToken && ghOrg) return { provider: 'github', token: ghToken, workspace: ghOrg };
  return null;
}

function buildRepoUrl(ci: CiProviderConfig, repo: string): string {
  if (ci.provider === 'github') {
    return `https://${ci.token}@github.com/${ci.workspace}/${repo}.git`;
  }
  // Bitbucket: x-token-auth is Bitbucket's HTTPS token scheme
  return `https://x-token-auth:${ci.token}@bitbucket.org/${ci.workspace}/${repo}.git`;
}

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

// Parse ECR image URL to get repo + branch.
// ECR tag format: {PRODUCT}-{TAG}-{40-char-sha}
// e.g. "fund-bloconnect-production-abc123..." → repo=jcp-blo-frontend, branch=production-fund-bloconnect
export function parseEcrImage(image: string): {
  repo: string;
  tagPrefix: string;
  branch: string | null;
  environment: string;
} | null {
  // Format: {account}.dkr.ecr.{region}.amazonaws.com/{repo}:{tag}
  const match = image.match(/amazonaws\.com\/([^:]+):(.+)/);
  if (!match) return null;

  const repo = match[1];        // e.g. "jcp-blo-frontend"
  const fullTag = match[2];     // e.g. "fund-bloconnect-production-abc123..."

  // Strip the 40-char hex SHA from the end
  const tagMatch = fullTag.match(/^(.+)-([a-f0-9]{40})$/);
  if (!tagMatch) return null;

  const tagPrefix = tagMatch[1]; // e.g. "fund-bloconnect-production"

  // Derive branch: "X-production" → "production-X", "X-development" → "development-X"
  let branch: string | null = null;
  let environment = 'unknown';
  for (const env of ['production', 'development', 'staging']) {
    if (tagPrefix.endsWith(`-${env}`)) {
      const product = tagPrefix.slice(0, -(env.length + 1));
      branch = `${env}-${product}`;
      environment = env;
      break;
    }
  }

  return { repo, tagPrefix, branch, environment };
}

// GET /api/ci/parse-image?namespace=...&podName=...
// Returns parsed repo/branch + active CI provider for the UI confirmation modal.
router.get('/parse-image', async (req: Request, res: Response) => {
  const { namespace, podName } = req.query as { namespace: string; podName: string };
  if (!namespace || !podName) {
    res.status(400).json({ error: 'namespace and podName are required' }); return;
  }
  try {
    const coreApi = getCoreApi();
    const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
    const containers = pod.spec?.containers ?? [];
    // Use first container's image (covers single-container pods, the common case)
    const image = containers[0]?.image ?? '';
    const parsed = parseEcrImage(image);
    if (!parsed) {
      res.status(422).json({ error: `Cannot parse ECR image: ${image}`, image }); return;
    }
    // Also resolve which CI provider is active so the UI can show it
    const ci = await resolveCiConfig();
    res.json({ image, ...parsed, ciProvider: ci?.provider ?? null, ciWorkspace: ci?.workspace ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/ci/rebuild  (superadmin only)
// Body: { namespace, podName }  — auto-detects repo+branch from pod image
//    OR { repo, branch }         — manual override
// Optional: { provider: 'bitbucket' | 'github' } — override auto-detect
router.post('/rebuild', async (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role !== 'superadmin') { res.status(403).json({ error: 'Requires superadmin' }); return; }

  const { namespace, podName, repo: manualRepo, branch: manualBranch, provider: preferredProvider } = req.body ?? {};
  const caller = (req as any).adminUser?.name ?? 'unknown';

  let repo: string;
  let branch: string;

  if (manualRepo && manualBranch) {
    repo   = String(manualRepo);
    branch = String(manualBranch);
  } else if (namespace && podName) {
    try {
      const coreApi = getCoreApi();
      const pod = await coreApi.readNamespacedPod({ name: String(podName), namespace: String(namespace) });
      const image = pod.spec?.containers?.[0]?.image ?? '';
      const parsed = parseEcrImage(image);
      if (!parsed) {
        res.status(422).json({ error: `Cannot parse ECR image: ${image}` }); return;
      }
      if (!parsed.branch) {
        res.status(422).json({
          error: 'Cannot auto-detect branch from tag prefix',
          repo: parsed.repo, tagPrefix: parsed.tagPrefix,
          hint: `Specify branch manually via { repo, branch } body.`,
        }); return;
      }
      repo   = parsed.repo;
      branch = parsed.branch;
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) }); return;
    }
  } else {
    res.status(400).json({ error: 'Provide {namespace, podName} or {repo, branch}' }); return;
  }

  // Validate repo/branch names (no path traversal)
  if (!/^[a-zA-Z0-9._-]+$/.test(repo) || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    res.status(400).json({ error: 'Invalid repo or branch name' }); return;
  }

  // Resolve CI provider from ConfigMap (with env var fallback)
  const ci = await resolveCiConfig(preferredProvider ? String(preferredProvider) : undefined);
  if (!ci) {
    res.status(503).json({
      error: 'No CI provider configured — go to Integrations → CI/CD Providers and add a Bitbucket or GitHub token',
    });
    return;
  }

  try {
    logger.info(`[ci] Rebuild triggered by ${caller} via ${ci.provider}: ${repo}@${branch}`);

    if (ci.provider === 'bitbucket') {
      // Bitbucket: trigger pipeline via API (write:pipeline:bitbucket scope only — no repo write needed)
      const triggerRes = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${ci.workspace}/${repo}/pipelines/`,
        {
          method: 'POST',
          headers: {
            Authorization: bbBasicAuth(ci.email ?? '', ci.token),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            target: {
              type: 'pipeline_ref_target',
              ref_type: 'branch',
              ref_name: branch,
              selector: { type: 'branches', pattern: branch },
            },
          }),
        },
      );
      if (!triggerRes.ok) {
        const errText = await (triggerRes as any).text().catch(() => '');
        if (triggerRes.status === 401) {
          res.status(503).json({ error: 'Bitbucket authentication failed — check token in Integrations (needs write:pipeline:bitbucket scope)' }); return;
        }
        if (triggerRes.status === 404) {
          res.status(404).json({ error: `Repo or branch "${branch}" not found in ${ci.workspace}/${repo}` }); return;
        }
        res.status(500).json({ error: `Bitbucket pipeline trigger failed (${triggerRes.status}): ${String(errText).slice(0, 200)}` }); return;
      }
      logger.info(`[ci] Bitbucket pipeline triggered: ${repo}@${branch} by ${caller}`);
      res.json({ ok: true, repo, branch, workspace: ci.workspace, provider: ci.provider });
    } else {
      // GitHub: push empty commit to trigger Actions workflow
      const tmpDir = `/tmp/bluey-rebuild-${Date.now()}`;
      try {
        const repoUrl = buildRepoUrl(ci, repo);
        await execFileAsync('git', [
          'clone', '--depth', '1', '--branch', branch, '--single-branch',
          repoUrl, tmpDir,
        ], { timeout: 60000 });
        await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'bluey@blueonion.today']);
        await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'BLUE.Y Dashboard']);
        await execFileAsync('git', [
          '-C', tmpDir, 'commit', '--allow-empty',
          '-m', `ci: rebuild triggered from BLUE.Y dashboard by ${caller} [BLY-70]`,
        ]);
        await execFileAsync('git', ['-C', tmpDir, 'push', 'origin', branch], { timeout: 30000 });
        logger.info(`[ci] GitHub rebuild push OK: ${repo}@${branch} by ${caller}`);
        res.json({ ok: true, repo, branch, workspace: ci.workspace, provider: ci.provider });
      } catch (e: any) {
        const msg = e?.stderr ?? e?.message ?? String(e);
        logger.error(`[ci] GitHub rebuild failed for ${repo}@${branch}: ${msg}`);
        if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
          res.status(503).json({ error: 'GitHub authentication failed — check your token in Integrations → CI/CD Providers' });
        } else if (msg.includes("couldn't find remote ref")) {
          res.status(404).json({ error: `Branch "${branch}" not found in ${repo}` });
        } else {
          res.status(500).json({ error: msg });
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.error(`[ci] Rebuild failed for ${repo}@${branch}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ── BLY-75: CI/CD Pipelines page — repos, branches, pipeline list, trigger, stop ──

// GET /api/ci/repos — list all repos in workspace
router.get('/repos', async (req: Request, res: Response) => {
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    if (ci.provider === 'bitbucket') {
      const data = await bbApi(ci.email ?? '', ci.token,
        `/repositories/${ci.workspace}?role=member&pagelen=50&fields=values.slug,values.name,values.full_name,values.is_private,values.updated_on`);
      const repos = (data.values ?? []).map((r: any) => ({
        slug: r.slug as string, name: r.name as string,
        fullName: r.full_name as string, isPrivate: r.is_private as boolean,
        updatedOn: r.updated_on as string,
      }));
      res.json({ repos, workspace: ci.workspace, provider: 'bitbucket' });
    } else {
      const data = await ghApi(ci.token, `/user/repos?per_page=50&sort=updated`);
      const repos = (data ?? []).map((r: any) => ({
        slug: r.name as string, name: r.name as string,
        fullName: r.full_name as string, isPrivate: r.private as boolean,
        updatedOn: r.updated_at as string,
      }));
      res.json({ repos, workspace: ci.workspace, provider: 'github' });
    }
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/ci/branches?repo= — list branches for a repo
router.get('/branches', async (req: Request, res: Response) => {
  const { repo } = req.query as Record<string, string>;
  if (!repo) { res.status(400).json({ error: 'repo is required' }); return; }
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    let branches: string[];
    if (ci.provider === 'bitbucket') {
      const data = await bbApi(ci.email ?? '', ci.token,
        `/repositories/${ci.workspace}/${repo}/refs/branches?pagelen=50&fields=values.name&sort=-target.date`);
      branches = (data.values ?? []).map((b: any) => b.name as string);
    } else {
      const data = await ghApi(ci.token, `/repos/${ci.workspace}/${repo}/branches?per_page=50`);
      branches = (data ?? []).map((b: any) => b.name as string);
    }
    res.json({ branches });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/ci/pipelines?repo=&page=&status= — paginated pipeline list
router.get('/pipelines', async (req: Request, res: Response) => {
  const { repo, page = '1', status } = req.query as Record<string, string>;
  if (!repo) { res.status(400).json({ error: 'repo is required' }); return; }
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    if (ci.provider === 'bitbucket') {
      let url = `/repositories/${ci.workspace}/${repo}/pipelines/?sort=-created_on&pagelen=20&page=${page}`;
      if (status && status !== 'all') {
        const stateMap: Record<string, string> = { running: 'IN_PROGRESS', pending: 'PENDING', passed: 'COMPLETED', failed: 'COMPLETED', stopped: 'COMPLETED' };
        if (stateMap[status]) url += `&status=${stateMap[status]}`;
      }
      const data = await bbApi(ci.email ?? '', ci.token, url);
      const pipelines = (data.values ?? []).map((p: any) => ({
        pipelineId: p.uuid as string,
        buildNumber: p.build_number as number,
        status: mapBbState(p.state),
        branch: (p.target?.ref_name ?? '') as string,
        createdAt: p.created_on as string,
        completedAt: (p.completed_on ?? null) as string | null,
        durationSeconds: (p.duration_in_seconds ?? null) as number | null,
        url: (p.links?.html?.href as string | undefined) ?? `https://bitbucket.org/${ci.workspace}/${repo}/pipelines/results/${p.build_number as number}`,
        triggeredBy: (p.trigger?.name ?? p.trigger?.type ?? 'manual') as string,
      }));
      res.json({ pipelines, page: Number(page), hasMore: !!data.next, provider: 'bitbucket', workspace: ci.workspace });
    } else {
      const data = await ghApi(ci.token,
        `/repos/${ci.workspace}/${repo}/actions/runs?per_page=20&page=${page}`);
      const pipelines = (data.workflow_runs ?? []).map((r: any) => ({
        pipelineId: String(r.id as number),
        buildNumber: r.run_number as number,
        status: mapGhStatus(r.status as string, r.conclusion as string | null),
        branch: r.head_branch as string,
        createdAt: r.created_at as string,
        completedAt: (r.updated_at ?? null) as string | null,
        durationSeconds: null as null,
        url: r.html_url as string,
        triggeredBy: r.event as string,
      }));
      res.json({ pipelines, page: Number(page), hasMore: (data.total_count as number) > Number(page) * 20, provider: 'github', workspace: ci.workspace });
    }
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/ci/steps?repo=&pipelineId= — steps for a specific pipeline
router.get('/steps', async (req: Request, res: Response) => {
  const { repo, pipelineId } = req.query as Record<string, string>;
  if (!repo || !pipelineId) { res.status(400).json({ error: 'repo and pipelineId are required' }); return; }
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    if (ci.provider === 'bitbucket') {
      const data = await bbApi(ci.email ?? '', ci.token,
        `/repositories/${ci.workspace}/${repo}/pipelines/${encodeURIComponent(pipelineId)}/steps/`);
      const steps = (data.values ?? []).map((s: any) => ({
        id: s.uuid as string,
        name: (s.name ?? s.type ?? 'Step') as string,
        status: mapBbState(s.state),
        durationSeconds: (s.duration_in_seconds ?? null) as number | null,
        startedAt: (s.started_on ?? null) as string | null,
      }));
      res.json({ steps });
    } else {
      const data = await ghApi(ci.token,
        `/repos/${ci.workspace}/${repo}/actions/runs/${encodeURIComponent(pipelineId)}/jobs`);
      const steps = (data.jobs ?? []).map((j: any) => {
        const dur = j.started_at && j.completed_at
          ? Math.round((new Date(j.completed_at as string).getTime() - new Date(j.started_at as string).getTime()) / 1000) : null;
        return {
          id: String(j.id as number), name: j.name as string,
          status: mapGhStatus(j.status as string, j.conclusion as string | null),
          durationSeconds: dur, startedAt: (j.started_at ?? null) as string | null,
        };
      });
      res.json({ steps });
    }
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/ci/trigger — trigger pipeline from CI/CD page (admin+)
router.post('/trigger', async (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role === 'viewer') { res.status(403).json({ error: 'Admin access required to trigger pipelines' }); return; }
  const { repo, branch } = req.body ?? {};
  if (!repo || !branch) { res.status(400).json({ error: 'repo and branch are required' }); return; }
  if (!/^[a-zA-Z0-9._-]+$/.test(String(repo)) || !/^[a-zA-Z0-9._/-]+$/.test(String(branch))) {
    res.status(400).json({ error: 'Invalid repo or branch name' }); return;
  }
  const caller = (req as any).adminUser?.name ?? 'unknown';
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    if (ci.provider === 'bitbucket') {
      const triggerRes = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${ci.workspace}/${String(repo)}/pipelines/`,
        {
          method: 'POST',
          headers: { Authorization: bbBasicAuth(ci.email ?? '', ci.token), 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: String(branch), selector: { type: 'branches', pattern: String(branch) } } }),
        },
      );
      if (!triggerRes.ok) {
        const errText = await (triggerRes as any).text().catch(() => '');
        if (triggerRes.status === 401) { res.status(503).json({ error: 'Bitbucket auth failed — check token scopes in Integrations' }); return; }
        if (triggerRes.status === 404) { res.status(404).json({ error: `Repo or branch "${String(branch)}" not found` }); return; }
        res.status(500).json({ error: `Trigger failed (${triggerRes.status}): ${String(errText).slice(0, 200)}` }); return;
      }
      const triggered: any = await (triggerRes as any).json();
      logger.info(`[ci] Pipeline triggered by ${caller}: ${String(repo)}@${String(branch)}`);
      res.json({ ok: true, pipelineId: triggered.uuid as string, buildNumber: triggered.build_number as number });
    } else {
      const tmpDir = `/tmp/bluey-trigger-${Date.now()}`;
      try {
        const repoUrl = buildRepoUrl(ci, String(repo));
        await execFileAsync('git', ['clone', '--depth', '1', '--branch', String(branch), '--single-branch', repoUrl, tmpDir], { timeout: 60000 });
        await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'bluey@blueonion.today']);
        await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'BLUE.Y Dashboard']);
        await execFileAsync('git', ['-C', tmpDir, 'commit', '--allow-empty', '-m', `ci: pipeline triggered from BLUE.Y CI/CD page by ${caller}`]);
        await execFileAsync('git', ['-C', tmpDir, 'push', 'origin', String(branch)], { timeout: 30000 });
        logger.info(`[ci] GitHub pipeline triggered by ${caller}: ${String(repo)}@${String(branch)}`);
        res.json({ ok: true });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/ci/stop — stop a running pipeline (admin+)
router.post('/stop', async (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role === 'viewer') { res.status(403).json({ error: 'Admin access required to stop pipelines' }); return; }
  const { pipelineId, repo } = req.body ?? {};
  if (!pipelineId || !repo) { res.status(400).json({ error: 'pipelineId and repo are required' }); return; }
  const ci = await resolveCiConfig();
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }
  try {
    if (ci.provider === 'bitbucket') {
      const stopRes = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${ci.workspace}/${String(repo)}/pipelines/${encodeURIComponent(String(pipelineId))}/stopPipeline`,
        { method: 'POST', headers: { Authorization: bbBasicAuth(ci.email ?? '', ci.token), 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!stopRes.ok && stopRes.status !== 204) {
        const errText = await (stopRes as any).text().catch(() => '');
        res.status(stopRes.status).json({ error: `Stop failed: ${String(errText).slice(0, 200)}` }); return;
      }
    } else {
      const cancelRes = await fetch(
        `https://api.github.com/repos/${ci.workspace}/${String(repo)}/actions/runs/${encodeURIComponent(String(pipelineId))}/cancel`,
        { method: 'POST', headers: { Authorization: `Bearer ${ci.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
      );
      if (!cancelRes.ok && cancelRes.status !== 202) {
        const errText = await (cancelRes as any).text().catch(() => '');
        res.status(cancelRes.status).json({ error: `Cancel failed: ${String(errText).slice(0, 200)}` }); return;
      }
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// ── BLY-74: Live Build Monitor ────────────────────────────────────────────────

function bbBasicAuth(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function bbApi(email: string, token: string, path: string): Promise<any> {
  const res = await fetch(`https://api.bitbucket.org/2.0${path}`, {
    headers: { Authorization: bbBasicAuth(email, token), Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await (res as any).text().catch(() => '');
    throw new Error(`Bitbucket API ${res.status}: ${String(text).slice(0, 200)}`);
  }
  return (res as any).json();
}

async function ghApi(token: string, path: string, followRedirect = false): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: followRedirect ? 'application/vnd.github+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: followRedirect ? 'follow' : 'manual',
  } as any);
  if (!followRedirect && res.status === 302) return { redirectUrl: res.headers.get('location') };
  if (!res.ok) {
    const text = await (res as any).text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${String(text).slice(0, 200)}`);
  }
  return (res as any).json();
}

function mapBbState(state: any): string {
  const s = state?.name?.toLowerCase() ?? '';
  const r = state?.result?.name?.toLowerCase() ?? '';
  if (s === 'completed') {
    if (r === 'successful') return 'passed';
    if (r === 'stopped') return 'stopped';
    return 'failed';
  }
  if (s === 'in_progress') return 'running';
  return 'pending';
}

function mapGhStatus(status: string, conclusion: string | null): string {
  if (status === 'completed') {
    if (conclusion === 'success') return 'passed';
    if (conclusion === 'cancelled') return 'stopped';
    return 'failed';
  }
  if (status === 'in_progress') return 'running';
  return 'pending';
}

// GET /api/ci/pipeline?repo=&branch=&provider=
// Returns latest pipeline status + steps for the Live Build Monitor.
router.get('/pipeline', async (req: Request, res: Response) => {
  const { repo, branch, provider: preferredProvider } = req.query as Record<string, string>;
  if (!repo || !branch) { res.status(400).json({ error: 'repo and branch are required' }); return; }

  const ci = await resolveCiConfig(preferredProvider);
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }

  try {
    if (ci.provider === 'bitbucket') {
      const data = await bbApi(ci.email ?? '', ci.token,
        `/repositories/${ci.workspace}/${repo}/pipelines/?sort=-created_on&pagelen=1&target.branch=${encodeURIComponent(branch)}`);
      const pipeline = data.values?.[0];
      if (!pipeline) { res.json({ found: false }); return; }

      const uuid = pipeline.uuid as string;
      const stepsData = await bbApi(ci.email ?? '', ci.token,
        `/repositories/${ci.workspace}/${repo}/pipelines/${encodeURIComponent(uuid)}/steps/`);

      const steps = (stepsData.values ?? []).map((s: any) => ({
        id: s.uuid as string,
        name: (s.name ?? s.type ?? 'Step') as string,
        status: mapBbState(s.state),
        durationSeconds: (s.duration_in_seconds ?? null) as number | null,
        startedAt: (s.started_on ?? null) as string | null,
      }));

      res.json({
        found: true,
        pipelineId: uuid,
        provider: 'bitbucket',
        buildNumber: pipeline.build_number as number,
        status: mapBbState(pipeline.state),
        branch: (pipeline.target?.ref_name ?? branch) as string,
        repo,
        createdAt: pipeline.created_on as string,
        completedAt: (pipeline.completed_on ?? null) as string | null,
        url: `https://bitbucket.org/${ci.workspace}/${repo}/pipelines/${pipeline.build_number as number}`,
        steps,
      });
    } else {
      // GitHub Actions
      const runsData = await ghApi(ci.token,
        `/repos/${ci.workspace}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`);
      const run = runsData.workflow_runs?.[0];
      if (!run) { res.json({ found: false }); return; }

      const jobsData = await ghApi(ci.token, `/repos/${ci.workspace}/${repo}/actions/runs/${run.id as number}/jobs`);
      const steps = (jobsData.jobs ?? []).map((j: any) => {
        const dur = j.started_at && j.completed_at
          ? Math.round((new Date(j.completed_at as string).getTime() - new Date(j.started_at as string).getTime()) / 1000)
          : null;
        return {
          id: String(j.id as number),
          name: j.name as string,
          status: mapGhStatus(j.status as string, j.conclusion as string | null),
          durationSeconds: dur,
          startedAt: (j.started_at ?? null) as string | null,
        };
      });

      res.json({
        found: true,
        pipelineId: String(run.id as number),
        provider: 'github',
        buildNumber: run.run_number as number,
        status: mapGhStatus(run.status as string, run.conclusion as string | null),
        branch: run.head_branch as string,
        repo,
        createdAt: run.created_at as string,
        completedAt: (run.updated_at ?? null) as string | null,
        url: run.html_url as string,
        steps,
      });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/ci/step-log?repo=&pipelineId=&stepId=&provider=
// Returns last 300 lines of a step/job log.
router.get('/step-log', async (req: Request, res: Response) => {
  const { repo, pipelineId, stepId, provider: preferredProvider } = req.query as Record<string, string>;
  if (!repo || !pipelineId || !stepId) {
    res.status(400).json({ error: 'repo, pipelineId, and stepId are required' }); return;
  }
  const ci = await resolveCiConfig(preferredProvider);
  if (!ci) { res.status(503).json({ error: 'No CI provider configured' }); return; }

  try {
    let text: string;
    if (ci.provider === 'bitbucket') {
      const logRes = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${ci.workspace}/${repo}/pipelines/${encodeURIComponent(pipelineId)}/steps/${encodeURIComponent(stepId)}/log`,
        { headers: { Authorization: `Bearer ${ci.token}`, Accept: 'text/plain' } },
      );
      if (!logRes.ok) { res.status(logRes.status).json({ error: `Log unavailable (${logRes.status})` }); return; }
      text = await (logRes as any).text();
    } else {
      // GitHub: GET /actions/jobs/{job_id}/logs → 302 redirect to signed URL
      const logRes = await fetch(
        `https://api.github.com/repos/${ci.workspace}/${repo}/actions/jobs/${encodeURIComponent(stepId)}/logs`,
        {
          headers: {
            Authorization: `Bearer ${ci.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'follow',
        } as any,
      );
      if (!logRes.ok) { res.status(logRes.status).json({ error: `Log unavailable (${logRes.status})` }); return; }
      text = await (logRes as any).text();
    }
    const lines = text.split('\n');
    res.json({ log: lines.slice(-300).join('\n'), total: lines.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
