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
  const ghToken     = data['ci.github.token']         || '';
  const ghOrg       = data['ci.github.org']           || '';

  if (preferredProvider === 'github' && ghToken && ghOrg) {
    return { provider: 'github', token: ghToken, workspace: ghOrg };
  }
  if (preferredProvider === 'bitbucket' && bbToken) {
    return { provider: 'bitbucket', token: bbToken, workspace: bbWorkspace };
  }
  // Auto-detect: Bitbucket first (existing deployments), then GitHub
  if (bbToken) return { provider: 'bitbucket', token: bbToken, workspace: bbWorkspace };
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

  const tmpDir = `/tmp/bluey-rebuild-${Date.now()}`;

  try {
    logger.info(`[ci] Rebuild triggered by ${caller} via ${ci.provider}: ${repo}@${branch}`);

    const repoUrl = buildRepoUrl(ci, repo);
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

    // Push back (authenticated URL already embedded in remote)
    await execFileAsync('git', ['-C', tmpDir, 'push', 'origin', branch], { timeout: 30000 });

    logger.info(`[ci] Rebuild push OK: ${repo}@${branch} by ${caller} (${ci.provider})`);
    res.json({ ok: true, repo, branch, workspace: ci.workspace, provider: ci.provider });
  } catch (e: any) {
    const msg = e?.stderr ?? e?.message ?? String(e);
    logger.error(`[ci] Rebuild failed for ${repo}@${branch}: ${msg}`);
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      res.status(503).json({
        error: `${ci.provider === 'github' ? 'GitHub' : 'Bitbucket'} authentication failed — check your token in Integrations → CI/CD Providers`,
      });
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
