// BLY-76 — AI Provider Configuration (BYOK)
// GET  /api/ai/providers — preset provider list with suggested models
// GET  /api/ai/config    — current AI config (secrets masked for non-superadmin)
// PUT  /api/ai/config    — save AI config to ConfigMap (superadmin only, enforced in index.ts)
// POST /api/ai/test      — test connection with real inference call
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const CONFIG_MAP_NAME = 'blue-y-config';

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}
function getNamespace(): string {
  return process.env.POD_NAMESPACE ?? config.kube.namespaces[0] ?? 'prod';
}
function isK8sNotFound(e: any): boolean {
  if (e?.response?.statusCode === 404) return true;
  try {
    const body = typeof e?.body === 'string' ? JSON.parse(e.body) : e?.body;
    if (body?.reason === 'NotFound') return true;
  } catch {}
  return String(e?.message ?? '').includes('HTTP-Code: 404');
}

const SENSITIVE_KEYS = new Set(['ai.api_key', 'ai.vision_api_key']);
const AI_CONFIG_KEYS = [
  'ai.provider', 'ai.base_url', 'ai.api_key',
  'ai.routine_model', 'ai.incident_model',
  'ai.vision_base_url', 'ai.vision_api_key', 'ai.vision_model',
] as const;

function maskValue(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return val.slice(0, 4) + '•'.repeat(val.length - 8) + val.slice(-4);
}

// Env-var defaults — so the UI shows what's currently active even before CM config is set
function getEnvDefault(key: string): string {
  const map: Record<string, string> = {
    'ai.provider':        'deepseek',
    'ai.base_url':        config.ai.baseUrl,
    'ai.api_key':         config.ai.apiKey,
    'ai.routine_model':   config.ai.routineModel,
    'ai.incident_model':  config.ai.incidentModel,
    'ai.vision_base_url': process.env.VISION_API_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
    'ai.vision_api_key':  process.env.VISION_API_KEY ?? '',
    'ai.vision_model':    process.env.VISION_MODEL ?? 'gemini-2.0-flash',
  };
  return map[key] ?? '';
}

// ── Provider catalogue ─────────────────────────────────────────────────────────

export const AI_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Best cost/performance. Default provider.',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    suggestedModels: {
      routine:  ['deepseek-chat'],
      incident: ['deepseek-reasoner'],
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, o3-mini. Widely supported.',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    suggestedModels: {
      routine:  ['gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-4o'],
      incident: ['o3-mini', 'gpt-4o', 'o1-mini'],
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    description: 'Gemini 2.0 Flash. Free tier available.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    suggestedModels: {
      routine:  ['gemini-2.0-flash', 'gemini-1.5-flash'],
      incident: ['gemini-2.0-flash-thinking-exp', 'gemini-1.5-pro'],
    },
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Self-hosted. No API key needed. Zero cost.',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    suggestedModels: {
      routine:  ['llama3.2', 'qwen2.5:7b', 'mistral'],
      incident: ['llama3.1:70b', 'deepseek-r1:8b', 'qwen2.5:32b'],
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude Haiku, Sonnet & Opus. Native Anthropic API — no proxy needed.',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    suggestedModels: {
      routine:  ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      incident: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAI-compatible endpoint (vLLM, LM Studio, Together AI…)',
    baseUrl: '',
    requiresKey: true,
    suggestedModels: { routine: [], incident: [] },
  },
];

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/ai/providers
router.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: AI_PROVIDERS });
});

// GET /api/ai/config
router.get('/config', async (req: Request, res: Response) => {
  const isSuperAdmin = (req as any).adminUser?.role === 'superadmin';
  let cmData: Record<string, string> = {};
  try {
    const cm = await getCoreApi().readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace: getNamespace() });
    cmData = cm.data ?? {};
  } catch { /* not found or not in cluster — use env defaults */ }

  const result: Record<string, string> = {};
  for (const key of AI_CONFIG_KEYS) {
    const raw = cmData[key] ?? getEnvDefault(key);
    result[key] = (isSuperAdmin || !SENSITIVE_KEYS.has(key)) ? raw : maskValue(raw);
  }

  // Derive configured provider from base_url if not explicitly set
  if (!cmData['ai.provider'] && cmData['ai.base_url']) {
    const url = cmData['ai.base_url'];
    const matched = AI_PROVIDERS.find(p => p.baseUrl && url.startsWith(p.baseUrl.split('/v')[0]));
    if (matched) result['ai.provider'] = matched.id;
  }

  res.json({
    config: result,
    hasKey: !!cmData['ai.api_key'],
    source: Object.keys(cmData).some(k => k.startsWith('ai.')) ? 'configmap' : 'env',
  });
});

// PUT /api/ai/config (superadmin only — enforced by index.ts)
router.put('/config', async (req: Request, res: Response) => {
  const updates = req.body as Record<string, string>;
  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ error: 'Body must be a key-value object' }); return;
  }

  const allowed = new Set<string>(AI_CONFIG_KEYS);
  for (const k of Object.keys(updates)) {
    if (!allowed.has(k)) { res.status(400).json({ error: `Unknown key: ${k}` }); return; }
  }

  const coreApi = getCoreApi();
  const namespace = getNamespace();
  const caller = (req as any).adminUser?.name ?? 'unknown';

  try {
    let currentData: Record<string, string> = {};
    try {
      const cm = await coreApi.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
      currentData = cm.data ?? {};
    } catch (e: any) { if (!isK8sNotFound(e)) throw e; }

    for (const [k, v] of Object.entries(updates)) {
      if (v === '') delete currentData[k]; else currentData[k] = v;
    }

    try {
      await coreApi.replaceNamespacedConfigMap({
        name: CONFIG_MAP_NAME, namespace,
        body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: currentData },
      });
    } catch (e: any) {
      if (isK8sNotFound(e)) {
        await coreApi.createNamespacedConfigMap({
          namespace,
          body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: currentData },
        });
      } else throw e;
    }

    logger.info(`[ai] Config updated by ${caller}: ${Object.keys(updates).join(', ')}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/ai/test — test connection using provided or saved config
router.post('/test', async (req: Request, res: Response) => {
  const body = req.body as { baseUrl?: string; apiKey?: string; model?: string };

  // Fall back to saved config if fields not provided
  let savedBase = config.ai.baseUrl;
  let savedKey = config.ai.apiKey;
  let savedModel = config.ai.routineModel;
  try {
    const cm = await getCoreApi().readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace: getNamespace() });
    const d = cm.data ?? {};
    if (d['ai.base_url']) savedBase = d['ai.base_url'];
    if (d['ai.api_key']) savedKey = d['ai.api_key'];
    if (d['ai.routine_model']) savedModel = d['ai.routine_model'];
  } catch { /* use env defaults */ }

  const testUrl   = body.baseUrl || savedBase;
  const testKey   = body.apiKey  || savedKey;
  const testModel = body.model   || savedModel;
  const useAnthropic = testUrl.includes('anthropic.com');

  const start = Date.now();
  try {
    let reply: string;
    let modelUsed: string;

    if (useAnthropic) {
      // Anthropic Messages API
      const response = await axios.post(
        `${testUrl}/messages`,
        { model: testModel, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }] },
        {
          headers: {
            'x-api-key': testKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      reply     = (response.data.content?.[0]?.text ?? '').trim();
      modelUsed = response.data.model ?? testModel;
    } else {
      // OpenAI-compatible API
      const response = await axios.post(
        `${testUrl}/chat/completions`,
        { model: testModel, messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }], max_tokens: 10, temperature: 0 },
        {
          headers: { Authorization: testKey ? `Bearer ${testKey}` : 'Bearer none', 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      reply     = (response.data.choices?.[0]?.message?.content ?? '').trim();
      modelUsed = response.data.model ?? testModel;
    }

    const latency = Date.now() - start;
    res.json({ ok: true, latency, reply, model: modelUsed });
  } catch (e: any) {
    const latency = Date.now() - start;
    const detail = e?.response?.data?.error?.message ?? e?.response?.data?.message ?? e?.message ?? String(e);
    res.json({ ok: false, latency, error: detail });
  }
});

export default router;
