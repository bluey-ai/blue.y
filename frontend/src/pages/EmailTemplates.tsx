// BLY-67: Email Templates page — SuperAdmin editor for all transactional email templates
import { useEffect, useState, useRef, useCallback } from 'react';
import { Mail, Save, RotateCcw, Send, RefreshCw, Check, X, Info, Copy } from 'lucide-react';
import {
  getEmailTemplates, saveEmailTemplate, resetEmailTemplate, testEmailTemplate,
} from '../api';
import type { EmailTemplate, EmailTemplateField } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

// ── Sample data for live preview ─────────────────────────────────────────────
const SAMPLE: Record<string, string> = {
  invitee_name:  'Jane Smith',
  inviter_name:  'You',
  role:          'admin',
  org_name:      'Your Organisation',
  dashboard_url: window.location.origin + '/admin/',
};

// Interpolate {{var}} tokens with either sample data or a highlighted span
function interpolate(text: string, highlight = false): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = SAMPLE[key] ?? `{{${key}}}`;
    return highlight
      ? `<span style="background:#ddf4ff;color:#0969da;border-radius:3px;padding:0 3px;font-size:inherit;">${val}</span>`
      : val;
  });
}

// Build the invite email preview HTML
function buildInvitePreview(fields: Record<string, string>, orgName: string): string {
  const welcomeMsg = fields['email.template.invite.welcome_msg'] || '';
  const footerMsg  = fields['email.template.invite.footer_msg'] || '';
  const roleLabel  = 'Admin'; // sample

  const welcomeBlock = welcomeMsg
    ? `<p style="margin:0 0 20px;color:#57606a;font-size:15px;line-height:1.6;">${interpolate(welcomeMsg, true)}</p>`
    : '';
  const footerLine = footerMsg ? `${interpolate(footerMsg, true)}<br>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>*{box-sizing:border-box}</style></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:24px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #d0d7de;max-width:520px;">
  <tr>
    <td style="background:#0d1117;padding:24px 32px;text-align:center;">
      <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
        <tr>
          <td style="background:#58a6ff;width:28px;height:28px;border-radius:7px;text-align:center;vertical-align:middle;font-size:13px;font-weight:700;color:#0d1117;">B</td>
          <td style="padding-left:9px;vertical-align:middle;">
            <span style="font-size:17px;font-weight:700;color:#e6edf3;">BLUE.Y</span>
          </td>
        </tr>
      </table>
      <p style="margin:6px 0 0;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">Admin Dashboard</p>
    </td>
  </tr>
  <tr>
    <td style="padding:28px 32px 22px;">
      <h1 style="margin:0 0 5px;font-size:20px;font-weight:700;color:#24292f;">Hi ${SAMPLE.invitee_name},</h1>
      <p style="margin:0 0 18px;color:#57606a;font-size:14px;line-height:1.6;">
        <strong style="color:#24292f;">${SAMPLE.inviter_name}</strong> has invited you to the
        <strong style="color:#24292f;">${orgName}</strong> BLUE.Y Admin Dashboard.
      </p>
      ${welcomeBlock}
      <p style="margin:0 0 6px;font-size:12px;color:#57606a;">Your role:</p>
      <p style="margin:0 0 22px;">
        <span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#ddf4ff;color:#0969da;border:1px solid #b6e3ff;">${roleLabel}</span>
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        <tr>
          <td style="border-radius:8px;background:#1f6feb;">
            <a href="${SAMPLE.dashboard_url}" style="display:inline-block;padding:11px 24px;font-size:13px;font-weight:600;color:#ffffff;text-decoration:none;">
              Sign in to Dashboard &#8594;
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0;color:#8b949e;font-size:12px;line-height:1.5;">
        Sign in with your Microsoft or Google account using this email address.<br>
        Your access is active immediately.
      </p>
    </td>
  </tr>
  <tr>
    <td style="padding:14px 32px 16px;background:#f6f8fa;border-top:1px solid #e1e4e8;">
      <p style="margin:0;font-size:11px;color:#8b949e;line-height:1.5;">
        ${footerLine}
        Powered by <strong>BLUE.Y</strong> &middot;
        <a href="${SAMPLE.dashboard_url}" style="color:#0969da;text-decoration:none;">Open Dashboard</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EmailTemplates() {
  const [templates, setTemplates]     = useState<EmailTemplate[]>([]);
  const [activeId, setActiveId]       = useState('');
  const [values, setValues]           = useState<Record<string, string>>({});
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [resetting, setResetting]     = useState(false);
  const [dirty, setDirty]             = useState(false);
  const [msg, setMsg]                 = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Test email modal state
  const [testOpen, setTestOpen]       = useState(false);
  const [testTo, setTestTo]           = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult]   = useState<{ ok: boolean; text: string } | null>(null);

  // Preview debounce
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');

  const activeTemplate = templates.find(t => t.id === activeId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { templates: tpls } = await getEmailTemplates();
      setTemplates(tpls);
      if (tpls.length > 0) {
        const first = tpls[0];
        setActiveId(first.id);
        const init: Record<string, string> = {};
        for (const f of first.fields) init[f.key] = f.value || f.default;
        setValues(init);
        setDirty(false);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // When tab changes, populate values from that template
  const switchTab = (tpl: EmailTemplate) => {
    setActiveId(tpl.id);
    const init: Record<string, string> = {};
    for (const f of tpl.fields) init[f.key] = f.value || f.default;
    setValues(init);
    setDirty(false);
    setMsg(null);
  };

  // Rebuild preview on values change (debounced)
  useEffect(() => {
    if (!activeTemplate) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      if (activeTemplate.id === 'invite') {
        const orgName = 'Your Organisation'; // sample
        setPreviewHtml(buildInvitePreview(values, orgName));
      }
    }, 250);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [values, activeTemplate]);

  const handleChange = (key: string, val: string) => {
    setValues(prev => ({ ...prev, [key]: val }));
    setDirty(true);
    setMsg(null);
  };

  const handleSave = async () => {
    if (!activeTemplate) return;
    setSaving(true); setMsg(null);
    try {
      // Only save keys that differ from their defaults (empty string = revert to default)
      const toSave: Record<string, string> = {};
      for (const f of activeTemplate.fields) {
        toSave[f.key] = values[f.key] ?? '';
      }
      await saveEmailTemplate(activeTemplate.id, toSave);
      setMsg({ type: 'ok', text: 'Template saved.' });
      setDirty(false);
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message });
    } finally { setSaving(false); }
  };

  const handleReset = async () => {
    if (!activeTemplate || !confirm(`Reset "${activeTemplate.label}" to defaults? Your customisations will be removed.`)) return;
    setResetting(true); setMsg(null);
    try {
      await resetEmailTemplate(activeTemplate.id);
      setMsg({ type: 'ok', text: 'Reset to defaults.' });
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message });
    } finally { setResetting(false); }
  };

  const handleSendTest = async () => {
    if (!activeTemplate || !testTo) return;
    setTestSending(true); setTestResult(null);
    try {
      const fields: Record<string, string> = {};
      for (const f of activeTemplate.fields) fields[f.key] = values[f.key] ?? '';
      const r = await testEmailTemplate(activeTemplate.id, testTo, fields);
      setTestResult({ ok: r.ok, text: r.message ?? (r.ok ? 'Sent!' : 'Failed.') });
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message });
    } finally { setTestSending(false); }
  };

  const copyVar = (v: string) => {
    navigator.clipboard.writeText(v).catch(() => {});
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Email Templates</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Customise transactional emails sent by BLUE.Y</p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors" title="Reload">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {loading ? (
        <p className="text-center text-sm text-[#6e7681] py-10">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-center text-sm text-[#6e7681] py-10">No templates found.</p>
      ) : (
        <>
          {/* Template tabs */}
          <div className="flex gap-2 border-b border-[#30363d] pb-0">
            {templates.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => switchTab(tpl)}
                className={clsx(
                  'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                  activeId === tpl.id
                    ? 'border-[#58a6ff] text-[#58a6ff]'
                    : 'border-transparent text-[#8b949e] hover:text-[#e6edf3]',
                )}
              >
                {tpl.label}
              </button>
            ))}
          </div>

          {activeTemplate && (
            <>
              {/* Description */}
              <div className="flex items-start gap-2 rounded-lg border border-[#30363d] px-4 py-3 text-xs text-[#8b949e]">
                <Info size={12} className="text-[#58a6ff] mt-0.5 shrink-0" />
                <div>
                  <span className="text-[#e6edf3]">{activeTemplate.description}</span>
                  <span className="text-[#6e7681]"> · Trigger: {activeTemplate.trigger}</span>
                </div>
              </div>

              {/* Status message */}
              {msg && (
                <div className={clsx('rounded-lg border px-4 py-2 text-sm',
                  msg.type === 'ok'
                    ? 'border-[#3fb950]/30 bg-[#3fb950]/10 text-[#3fb950]'
                    : 'border-[#f85149]/30 bg-[#f85149]/10 text-[#f85149]')}>
                  {msg.text}
                </div>
              )}

              {/* Split pane */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* LEFT: Editor */}
                <Card padding={false}>
                  <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
                    <Mail size={14} className="text-[#58a6ff]" />
                    <span className="text-sm font-semibold text-[#e6edf3]">Editor</span>
                    {dirty && <span className="ml-auto text-[10px] text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/20 rounded px-2 py-0.5">Unsaved</span>}
                  </div>

                  <div className="p-4 space-y-4">
                    {activeTemplate.fields.map((f: EmailTemplateField) => (
                      <div key={f.key}>
                        <div className="flex items-center gap-2 mb-1">
                          <label className="text-[11px] font-medium text-[#8b949e]">{f.label}</label>
                          {values[f.key] !== f.default && values[f.key] !== '' && (
                            <span className="text-[9px] text-[#58a6ff] bg-[#58a6ff]/10 border border-[#58a6ff]/20 rounded px-1.5 py-0.5">Custom</span>
                          )}
                        </div>
                        {f.type === 'textarea' ? (
                          <textarea
                            value={values[f.key] ?? ''}
                            onChange={e => handleChange(f.key, e.target.value)}
                            placeholder={f.default || `Enter ${f.label.toLowerCase()} (optional)`}
                            rows={3}
                            className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff] resize-none leading-relaxed"
                          />
                        ) : (
                          <input
                            type="text"
                            value={values[f.key] ?? ''}
                            onChange={e => handleChange(f.key, e.target.value)}
                            placeholder={f.default}
                            className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
                          />
                        )}
                        {f.hint && <p className="mt-1 text-[10px] text-[#6e7681]">{f.hint}</p>}
                      </div>
                    ))}

                    {/* Variable chips */}
                    <div>
                      <p className="text-[10px] text-[#6e7681] mb-2">Available variables — click to copy:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {activeTemplate.variables.map(v => (
                          <button
                            key={v.name}
                            onClick={() => copyVar(v.name)}
                            title={v.desc}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-[#0d1117] border border-[#30363d] text-[#79c0ff] hover:border-[#58a6ff] transition-colors"
                          >
                            <Copy size={8} />
                            {v.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Action bar */}
                  <div className="px-4 py-3 border-t border-[#30363d] flex items-center gap-2">
                    <button
                      onClick={handleReset}
                      disabled={resetting}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/50 transition-colors disabled:opacity-40"
                    >
                      <RotateCcw size={10} /> {resetting ? 'Resetting…' : 'Reset to default'}
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={() => { setTestOpen(true); setTestResult(null); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff]/50 transition-colors"
                    >
                      <Send size={10} /> Send test
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || !dirty}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save size={10} /> {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </Card>

                {/* RIGHT: Preview */}
                <Card padding={false} className="flex flex-col">
                  <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2 shrink-0">
                    <span className="text-sm font-semibold text-[#e6edf3]">Live Preview</span>
                    <span className="text-[10px] text-[#6e7681] ml-1">sample data</span>
                  </div>
                  <div className="flex-1 overflow-hidden rounded-b-xl" style={{ minHeight: '460px' }}>
                    <iframe
                      srcDoc={previewHtml}
                      className="w-full h-full border-0 rounded-b-xl"
                      title="Email preview"
                      sandbox="allow-same-origin"
                      style={{ minHeight: '460px' }}
                    />
                  </div>
                </Card>

              </div>
            </>
          )}
        </>
      )}

      {/* Test email modal */}
      {testOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={e => { if (e.target === e.currentTarget) setTestOpen(false); }}
        >
          <div className="w-full max-w-sm mx-4 bg-[#161b22] rounded-xl border border-[#30363d] shadow-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <Send size={14} className="text-[#58a6ff]" />
              <h2 className="text-sm font-semibold text-[#e6edf3]">Send Test Email</h2>
              <button onClick={() => setTestOpen(false)} className="ml-auto p-1 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]">
                <X size={13} />
              </button>
            </div>
            <p className="text-xs text-[#8b949e] mb-4">
              Sends the current (unsaved) template with sample data to the address below.
            </p>
            <label className="block text-[10px] text-[#6e7681] mb-1">Recipient email</label>
            <input
              type="email"
              value={testTo}
              onChange={e => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff] mb-4"
            />
            {testResult && (
              <div className={clsx('flex items-center gap-2 text-xs rounded border px-3 py-2 mb-4',
                testResult.ok
                  ? 'text-[#3fb950] bg-[#3fb950]/5 border-[#3fb950]/20'
                  : 'text-[#f85149] bg-[#f85149]/5 border-[#f85149]/20')}>
                {testResult.ok ? <Check size={11} /> : <X size={11} />}
                {testResult.text}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setTestOpen(false)} className="px-3 py-1.5 text-xs rounded-lg border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                Close
              </button>
              <button
                onClick={handleSendTest}
                disabled={testSending || !testTo}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[#1f6feb] hover:bg-[#388bfd] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={10} /> {testSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e]">
        ℹ Customisations are saved to the <code className="font-mono bg-[#0d1117] px-1 rounded">blue-y-config</code> ConfigMap.
        Set <code className="font-mono bg-[#0d1117] px-1 rounded">email.org_name</code> in Config to control the organisation name shown in emails.
      </div>
    </div>
  );
}
