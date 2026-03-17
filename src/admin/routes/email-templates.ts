// @premium — BlueOnion internal only. (BLY-67)
// Email Templates — SuperAdmin editor for all transactional email templates.
// Customisations are stored in blue-y-config ConfigMap under email.template.* keys.
import { Router, Request, Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { EmailClient } from '../../clients/email';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const router = Router();
const emailClient = new EmailClient();
const CONFIG_MAP_NAME = 'blue-y-config';

// ── Template definitions ──────────────────────────────────────────────────────

interface TemplateField {
  key: string;         // ConfigMap key
  label: string;
  type: 'text' | 'textarea';
  default: string;
  hint?: string;
}

interface TemplateVariable {
  name: string;
  desc: string;
}

interface TemplateDef {
  id: string;
  label: string;
  description: string;
  trigger: string;
  fields: TemplateField[];
  variables: TemplateVariable[];
}

const TEMPLATE_DEFS: Record<string, TemplateDef> = {
  'alert-triggered': {
    id: 'alert-triggered',
    label: 'Service Alert — Triggered',
    description: 'Sent to alert recipients when a service or pod fails health checks consecutively or enters a crash state (CrashLoopBackOff, ImagePullBackOff).',
    trigger: 'Pod enters crash state OR health check fails N times in a row',
    fields: [
      { key: 'email.template.alert-triggered.subject',   label: 'Subject',       type: 'text',     default: '[{{monitor_name}}] Alert triggered', hint: 'Supports {{monitor_name}}.' },
      { key: 'email.template.alert-triggered.from_name', label: 'From Name',     type: 'text',     default: 'BLUE.Y Alerts', hint: 'Sender display name.' },
      { key: 'email.template.alert-triggered.body_text', label: 'Body Text',     type: 'textarea', default: 'An alert for {{monitor_name}} has been triggered due to having failed {{fail_count}} time(s) in a row.', hint: 'Main paragraph. Supports all variables.' },
      { key: 'email.template.alert-triggered.footer_msg',label: 'Footer Message',type: 'textarea', default: '', hint: 'Optional footer line. Leave blank to omit.' },
    ],
    variables: [
      { name: '{{monitor_name}}',     desc: 'Service or monitor name (e.g. "Core Services/BlueConnect")' },
      { name: '{{fail_count}}',       desc: 'Number of consecutive failures' },
      { name: '{{alert_description}}',desc: 'Alert description (e.g. "Health check failed")' },
      { name: '{{triggered_at}}',     desc: 'Timestamp when alert was triggered' },
    ],
  },
  'alert-resolved': {
    id: 'alert-resolved',
    label: 'Service Alert — Resolved',
    description: 'Sent when a service recovers after an alert state — pod returns to Running or health checks pass consecutively.',
    trigger: 'Pod returns to Running / health checks pass consecutively after alert',
    fields: [
      { key: 'email.template.alert-resolved.subject',   label: 'Subject',       type: 'text',     default: '[{{monitor_name}}] Alert resolved', hint: 'Supports {{monitor_name}}.' },
      { key: 'email.template.alert-resolved.from_name', label: 'From Name',     type: 'text',     default: 'BLUE.Y Alerts' },
      { key: 'email.template.alert-resolved.body_text', label: 'Body Text',     type: 'textarea', default: 'An alert for {{monitor_name}} has been resolved after passing successfully {{pass_count}} time(s) in a row.' },
      { key: 'email.template.alert-resolved.footer_msg',label: 'Footer Message',type: 'textarea', default: '' },
    ],
    variables: [
      { name: '{{monitor_name}}', desc: 'Service or monitor name' },
      { name: '{{pass_count}}',   desc: 'Number of consecutive successful checks before resolve' },
      { name: '{{resolved_at}}',  desc: 'Timestamp when alert was resolved' },
    ],
  },
  invite: {
    id: 'invite',
    label: 'User Invitation',
    description: 'Sent when a SuperAdmin invites a new user to the dashboard.',
    trigger: 'Invite user → "Send email" checkbox',
    fields: [
      { key: 'email.template.invite.subject',     label: 'Subject',         type: 'text',     default: "You've been invited to {{org_name}} BLUE.Y Dashboard",  hint: 'Email subject line. Supports {{org_name}}.' },
      { key: 'email.template.invite.from_name',   label: 'From Name',       type: 'text',     default: 'BLUE.Y Admin', hint: 'Sender display name (combined with FROM address from Email integration).' },
      { key: 'email.template.invite.body_text',    label: 'Invitation Text',    type: 'textarea', default: '{{inviter_name}} has invited you to the {{org_name}} BLUE.Y Admin Dashboard.', hint: 'Main invitation paragraph. Supports all variables.' },
      { key: 'email.template.invite.cta_label',    label: 'Button Label',       type: 'text',     default: 'Sign in to Dashboard', hint: 'Text on the sign-in button.' },
      { key: 'email.template.invite.instructions', label: 'Instructions Text',  type: 'textarea', default: 'Sign in with your Microsoft or Google account using this email address.\nYour access is active immediately — no waiting required.', hint: 'Text shown below the button.' },
      { key: 'email.template.invite.welcome_msg', label: 'Welcome Message', type: 'textarea', default: '', hint: 'Optional paragraph below the invitation. Leave blank to omit.' },
      { key: 'email.template.invite.footer_msg',  label: 'Footer Message',  type: 'textarea', default: '', hint: 'Optional line in the email footer. Leave blank to omit.' },
    ],
    variables: [
      { name: '{{invitee_name}}', desc: 'Name or email prefix of the invited person' },
      { name: '{{inviter_name}}', desc: 'Display name of the SuperAdmin who sent the invite' },
      { name: '{{role}}',         desc: 'Assigned role: Admin or Viewer' },
      { name: '{{org_name}}',     desc: 'Organisation name (set via email.org_name ConfigMap key)' },
      { name: '{{dashboard_url}}',desc: 'Admin dashboard URL (auto-derived from ADMIN_HOST)' },
    ],
  },
};

// ── K8s helpers ───────────────────────────────────────────────────────────────

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

function getNamespace(): string {
  return config.kube.namespaces[0] || 'prod';
}

function isK8sNotFound(e: any): boolean {
  if (e?.response?.statusCode === 404) return true;
  try {
    const body = typeof e?.body === 'string' ? JSON.parse(e.body) : e?.body;
    if (body?.reason === 'NotFound') return true;
  } catch {}
  return String(e?.message ?? '').includes('HTTP-Code: 404');
}

async function readConfigMap(): Promise<Record<string, string>> {
  try {
    const cm = await getCoreApi().readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace: getNamespace() });
    return cm.data ?? {};
  } catch (e: any) {
    if (isK8sNotFound(e)) return {};
    throw e;
  }
}

async function patchConfigMap(updates: Record<string, string | null>): Promise<void> {
  const api = getCoreApi();
  const namespace = getNamespace();
  let current: Record<string, string> = {};
  try {
    const cm = await api.readNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace });
    current = cm.data ?? {};
  } catch (e: any) {
    if (!isK8sNotFound(e)) throw e;
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === '') {
      delete current[k];
    } else {
      current[k] = v;
    }
  }
  try {
    await api.replaceNamespacedConfigMap({ name: CONFIG_MAP_NAME, namespace, body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: current } });
  } catch (e: any) {
    if (isK8sNotFound(e)) {
      await api.createNamespacedConfigMap({ namespace, body: { metadata: { name: CONFIG_MAP_NAME, namespace }, data: current } });
    } else {
      throw e;
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/email-templates — list all templates with current customisations
router.get('/', async (_req: Request, res: Response) => {
  try {
    const cfg = await readConfigMap();
    const templates = Object.values(TEMPLATE_DEFS).map(def => ({
      ...def,
      fields: def.fields.map(f => ({
        ...f,
        value: cfg[f.key] ?? '',          // '' means "using default"
        isCustomised: f.key in cfg,
      })),
    }));
    res.json({ templates });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// PUT /api/email-templates/:id — save field customisations to ConfigMap
// Body: { fields: { "email.template.invite.subject": "...", ... } }
router.put('/:id', async (req: Request, res: Response) => {
  const def = TEMPLATE_DEFS[req.params.id as string];
  if (!def) { res.status(404).json({ error: 'Unknown template' }); return; }

  const fields = req.body?.fields as Record<string, string> | undefined;
  if (!fields || typeof fields !== 'object') {
    res.status(400).json({ error: 'Body must be { "fields": { "key": "value" } }' });
    return;
  }
  const allowedKeys = new Set(def.fields.map(f => f.key));
  for (const k of Object.keys(fields)) {
    if (!allowedKeys.has(k)) { res.status(400).json({ error: `Unknown field: ${k}` }); return; }
  }

  try {
    // Empty string → remove key (revert to default); non-empty → save
    const updates: Record<string, string | null> = {};
    for (const f of def.fields) {
      if (f.key in fields) {
        updates[f.key] = fields[f.key] === '' ? null : fields[f.key];
      }
    }
    await patchConfigMap(updates);
    const caller = (req as any).adminUser?.name ?? 'unknown';
    logger.info(`[email-templates] Template '${def.id}' updated by ${caller}`);
    res.json({ ok: true, template: def.id });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// DELETE /api/email-templates/:id — reset all fields to defaults (remove from ConfigMap)
router.delete('/:id', async (req: Request, res: Response) => {
  const def = TEMPLATE_DEFS[req.params.id as string];
  if (!def) { res.status(404).json({ error: 'Unknown template' }); return; }
  try {
    const updates: Record<string, null> = {};
    for (const f of def.fields) updates[f.key] = null;
    await patchConfigMap(updates);
    const caller = (req as any).adminUser?.name ?? 'unknown';
    logger.info(`[email-templates] Template '${def.id}' reset to defaults by ${caller}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/email-templates/:id/test — send test email with current (unsaved) values
// Body: { to: string, fields: Record<string, string> }
router.post('/:id/test', async (req: Request, res: Response) => {
  const def = TEMPLATE_DEFS[req.params.id as string];
  if (!def) { res.status(404).json({ error: 'Unknown template' }); return; }

  const { to, fields } = req.body ?? {};
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    res.status(400).json({ error: '"to" must be a valid email address' });
    return;
  }

  try {
    // Merge saved ConfigMap values + unsaved field overrides from request
    const cfg = await readConfigMap();
    const merged: Record<string, string> = {};
    for (const f of def.fields) {
      merged[f.key] = (typeof fields?.[f.key] === 'string' ? fields[f.key] : cfg[f.key]) ?? f.default;
    }

    if (def.id === 'alert-triggered' || def.id === 'alert-resolved') {
      const isTriggered = def.id === 'alert-triggered';
      const orgName     = cfg['email.org_name'] || 'BLUE.Y';
      const fromName    = (isTriggered ? merged['email.template.alert-triggered.from_name'] : merged['email.template.alert-resolved.from_name']) || 'BLUE.Y Alerts';
      const rawSubject  = (isTriggered ? merged['email.template.alert-triggered.subject'] : merged['email.template.alert-resolved.subject'])
        || def.fields.find(f => f.key.endsWith('.subject'))!.default;
      const rawBodyText = (isTriggered ? merged['email.template.alert-triggered.body_text'] : merged['email.template.alert-resolved.body_text'])
        || def.fields.find(f => f.key.endsWith('.body_text'))!.default;
      const footerMsg   = (isTriggered ? merged['email.template.alert-triggered.footer_msg'] : merged['email.template.alert-resolved.footer_msg']) || '';

      const sampleMonitor = 'Core Services/BlueConnect';
      const subject = rawSubject.replace(/\{\{monitor_name\}\}/g, sampleMonitor) + ' [TEST]';
      const bodyText = rawBodyText
        .replace(/\{\{monitor_name\}\}/g, sampleMonitor)
        .replace(/\{\{fail_count\}\}/g, '3')
        .replace(/\{\{pass_count\}\}/g, '2')
        .replace(/\{\{triggered_at\}\}/g, new Date().toISOString())
        .replace(/\{\{resolved_at\}\}/g, new Date().toISOString());

      const sampleConditions = isTriggered
        ? [{ label: '[STATUS] (503) < 500', passed: false }, { label: '[RESPONSE_TIME] < 10000', passed: true }]
        : [{ label: '[STATUS] < 500', passed: true }, { label: '[RESPONSE_TIME] < 10000', passed: true }];

      const html = emailClient.buildAlertHtml({
        type: isTriggered ? 'triggered' : 'resolved',
        monitorName: sampleMonitor,
        bodyText,
        alertDescription: isTriggered ? 'Health check failed' : undefined,
        count: isTriggered ? 3 : 2,
        conditions: sampleConditions,
        footerMsg,
        timestamp: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore' }) + ' SGT',
        orgName,
      });
      const sent = await emailClient.send(to, fromName, subject, html);
      if (sent) {
        res.json({ ok: true, message: `Test alert email sent to ${to}` });
      } else {
        res.status(500).json({ ok: false, message: 'Email delivery failed — check SES/SMTP config.' });
      }
      return;
    }

    if (def.id === 'invite') {
      const orgName    = cfg['email.org_name'] || 'BLUE.Y';
      const fromName   = merged['email.template.invite.from_name'] || 'BLUE.Y Admin';
      const welcomeMsg = merged['email.template.invite.welcome_msg'] || '';
      const footerMsg  = merged['email.template.invite.footer_msg'] || '';
      const bodyText     = merged['email.template.invite.body_text']    || def.fields.find(f => f.key.endsWith('.body_text'))!.default;
      const ctaLabel     = merged['email.template.invite.cta_label']    || def.fields.find(f => f.key.endsWith('.cta_label'))!.default;
      const instructions = merged['email.template.invite.instructions'] || def.fields.find(f => f.key.endsWith('.instructions'))!.default;
      const rawSubject = merged['email.template.invite.subject'] || def.fields.find(f => f.key.endsWith('.subject'))!.default;
      const subject    = rawSubject.replace(/\{\{org_name\}\}/g, orgName) + ' [TEST]';
      const dashboardUrl = (config.admin.host || '') + '/admin/';
      const inviterName  = (req as any).adminUser?.name || 'SuperAdmin';

      const html = emailClient.buildInviteHtml({
        inviteeName:  'Jane Smith (sample)',
        inviterName,
        role:         'admin',
        dashboardUrl,
        orgName,
        welcomeMsg,
        footerMsg,
        bodyText,
        ctaLabel,
        instructions,
      });
      const sent = await emailClient.send(to, fromName, subject, html);
      if (sent) {
        res.json({ ok: true, message: `Test email sent to ${to}` });
      } else {
        res.status(500).json({ ok: false, message: 'Email delivery failed — check SES/SMTP config.' });
      }
    } else {
      res.status(400).json({ error: 'No test handler for this template yet' });
    }
  } catch (e: any) {
    res.status(500).json({ ok: false, message: e?.message ?? String(e) });
  }
});

export default router;
