// BLY-70 — Smart Rebuild: trigger Bitbucket pipeline via git push from pod
// Uses HTTPS + BB_TOKEN (x-token-auth scheme) — no SSH key needed.
// BB_TOKEN must have repository:write scope. Update blue-y-secrets if needed.
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { logger } from '../../utils/logger';

const router = Router();
const execFileAsync = promisify(execFile);

const WORKSPACE = 'blue-onion';

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
// Returns parsed repo/branch for the UI confirmation modal.
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
    res.json({ image, ...parsed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/ci/rebuild  (superadmin only)
// Body: { namespace, podName }  — auto-detects repo+branch from pod image
//    OR { repo, branch }         — manual override
router.post('/rebuild', async (req: Request, res: Response) => {
  const role: string = (req as any).adminUser?.role ?? 'viewer';
  if (role !== 'superadmin') { res.status(403).json({ error: 'Requires superadmin' }); return; }

  const { namespace, podName, repo: manualRepo, branch: manualBranch } = req.body ?? {};
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

  // Validate repo name (only alphanumeric, dash, dot — no path traversal)
  if (!/^[a-zA-Z0-9._-]+$/.test(repo) || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    res.status(400).json({ error: 'Invalid repo or branch name' }); return;
  }

  const bbToken = process.env.BB_TOKEN ?? '';
  if (!bbToken) {
    res.status(503).json({ error: 'BB_TOKEN not configured — update blue-y-secrets with a Bitbucket API token (repository:write scope)' });
    return;
  }

  const tmpDir = `/tmp/bluey-rebuild-${Date.now()}`;

  try {
    logger.info(`[ci] Rebuild triggered by ${caller}: ${repo}@${branch}`);

    // Clone with depth=1 using HTTPS + token (x-token-auth is Bitbucket's scheme)
    const repoUrl = `https://x-token-auth:${bbToken}@bitbucket.org/${WORKSPACE}/${repo}.git`;
    await execFileAsync('git', [
      'clone', '--depth', '1', '--branch', branch, '--single-branch',
      repoUrl, tmpDir,
    ], { timeout: 60000 });

    // Configure git identity for the commit
    await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'bluey@blueonion.today']);
    await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'BLUE.Y Dashboard']);

    // Empty commit to trigger the pipeline
    await execFileAsync('git', [
      '-C', tmpDir, 'commit', '--allow-empty',
      '-m', `ci: rebuild triggered from BLUE.Y dashboard by ${caller} [BLY-70]`,
    ]);

    // Push back (using same authenticated URL stored in remote)
    await execFileAsync('git', ['-C', tmpDir, 'push', 'origin', branch], { timeout: 30000 });

    logger.info(`[ci] Rebuild push OK: ${repo}@${branch} by ${caller}`);
    res.json({ ok: true, repo, branch, workspace: WORKSPACE });
  } catch (e: any) {
    const msg = e?.stderr ?? e?.message ?? String(e);
    logger.error(`[ci] Rebuild failed for ${repo}@${branch}: ${msg}`);
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      res.status(503).json({ error: 'Bitbucket authentication failed — update BB_TOKEN in blue-y-secrets with a token that has repository:write scope' });
    } else if (msg.includes("couldn't find remote ref")) {
      res.status(404).json({ error: `Branch "${branch}" not found in ${repo}. Override with {repo, branch} in the request body.` });
    } else {
      res.status(500).json({ error: msg });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

export default router;
