import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Edit2, Save, X, HelpCircle, ChevronDown, ChevronRight, ExternalLink, Zap, Loader2 } from 'lucide-react';
import { getIntegrations, saveIntegration, testIntegration } from '../api';
import type { Integration } from '../api';

type TestStatus = 'connected' | 'failed' | 'not_configured';
interface TestState { loading: boolean; status?: TestStatus; message?: string; }
import Card from '../components/Card';
import clsx from 'clsx';

const PLATFORM_COLOR: Record<string, string> = {
  telegram:       'text-[#0088cc] bg-[#0088cc]/10 border-[#0088cc]/20',
  slack:          'text-[#4a154b] bg-[#4a154b]/10 border-[#4a154b]/20',
  microsoft:      'text-[#6264a7] bg-[#6264a7]/10 border-[#6264a7]/20',
  whatsapp:       'text-[#25d366] bg-[#25d366]/10 border-[#25d366]/20',
  email:          'text-[#ff9900] bg-[#ff9900]/10 border-[#ff9900]/20',
  'microsoft-sso': 'text-[#00a4ef] bg-[#00a4ef]/10 border-[#00a4ef]/20',
  'google-sso':    'text-[#ea4335] bg-[#ea4335]/10 border-[#ea4335]/20',
  bitbucket:      'text-[#0052cc] bg-[#0052cc]/10 border-[#0052cc]/20',
  github:         'text-[#e6edf3] bg-[#30363d] border-[#484f58]',
};

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'TG', slack: 'SL', microsoft: 'MS', whatsapp: 'WA', email: 'SES',
  'microsoft-sso': 'MS', 'google-sso': 'G',
  bitbucket: 'BB', github: 'GH',
};

const SETUP_GUIDES: Record<string, { steps: string[]; links: { label: string; url: string }[] }> = {
  telegram: {
    steps: [
      '1. Open Telegram and search for @BotFather',
      '2. Send /newbot — follow prompts to name your bot',
      '3. Copy the Bot Token (looks like 123456789:ABC-xxx)',
      '4. Add the bot to your monitoring group/channel',
      '5. Get your Chat ID: send a message to the group, then visit https://api.telegram.org/bot<TOKEN>/getUpdates',
      '6. Admin ID: your personal Telegram numeric user ID (use @userinfobot to find it)',
    ],
    links: [{ label: 'BotFather', url: 'https://t.me/BotFather' }, { label: 'userinfobot', url: 'https://t.me/userinfobot' }],
  },
  slack: {
    steps: [
      '1. Go to api.slack.com/apps → Create New App → From scratch',
      '2. Enable Socket Mode under Settings → get the App-Level Token (xapp-...)',
      '3. Go to OAuth & Permissions → add bot scopes: chat:write, channels:read, groups:read',
      '4. Install the app to your workspace → copy the Bot Token (xoxb-...)',
      '5. Add the bot to your alert channel → copy the Channel ID (right-click channel → View channel details)',
    ],
    links: [{ label: 'Slack API Apps', url: 'https://api.slack.com/apps' }],
  },
  microsoft: {
    steps: [
      '1. Go to Azure Portal → App registrations → New registration',
      '2. Set Redirect URI to: https://blue-y.blueonion.today/admin/auth/microsoft/callback',
      '3. Copy the Application (client) ID and Directory (tenant) ID',
      '4. Under Certificates & secrets → New client secret → copy the value immediately',
      '5. Under API permissions → add Microsoft Graph: User.Read (for SSO login)',
    ],
    links: [{ label: 'Azure App Registrations', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps' }],
  },
  whatsapp: {
    steps: [
      '1. Sign up at twilio.com → go to Console → Messaging → Try it out → Send a WhatsApp message',
      '2. Copy your Account SID and Auth Token from the Console dashboard',
      '3. The From Number is your Twilio WhatsApp sandbox number (e.g. +14155238886)',
      '4. For production: request a Twilio WhatsApp Business number and submit for approval',
    ],
    links: [{ label: 'Twilio Console', url: 'https://console.twilio.com' }],
  },
  email: {
    steps: [
      '1. Go to AWS Console → SES → Verified identities → verify your sending domain or address',
      '2. Set FROM Address to a verified address (e.g. noreply@yourdomain.com)',
      '3. Set Alert Recipient to where incident emails should be delivered',
      '4. SES Region: the AWS region your SES is configured in (default: ap-southeast-1)',
      '5. The bot uses its EKS pod IAM role (IRSA) for SES auth — no API key needed',
      '6. If in SES sandbox mode, the recipient address must also be verified in SES',
      '7. To exit sandbox: AWS Console → SES → Account dashboard → Request production access',
    ],
    links: [
      { label: 'SES Console', url: 'https://console.aws.amazon.com/ses/home' },
      { label: 'Verified identities', url: 'https://console.aws.amazon.com/ses/home#/verified-identities' },
    ],
  },
  'microsoft-sso': {
    steps: [
      '1. Sign in to portal.azure.com → search "App registrations" → New registration',
      '2. Name: "BLUE.Y SSO" — Supported account types: "Accounts in this org directory only"',
      '3. Redirect URI → Web → https://blue-y.blueonion.today/admin/auth/microsoft/callback',
      '4. Click Register — copy the Application (client) ID → paste as Client ID',
      '5. Copy the Directory (tenant) ID from the Overview page → paste as Tenant ID',
      '6. Go to Certificates & secrets → New client secret → set expiry → copy the Value immediately (shown once) → paste as Client Secret',
      '7. Go to API permissions → Add permission → Microsoft Graph → Delegated → add: openid, profile, email → Grant admin consent',
      '8. Save credentials here — SSO login buttons appear immediately (no restart needed)',
    ],
    links: [
      { label: 'Azure App Registrations', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps' },
      { label: 'Azure AD Docs', url: 'https://learn.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app' },
    ],
  },
  'google-sso': {
    steps: [
      '1. Go to console.cloud.google.com → select or create a project',
      '2. APIs & Services → OAuth consent screen → External → fill in App name, support email → Save',
      '3. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID',
      '4. Application type: Web application — Name: "BLUE.Y SSO"',
      '5. Authorised redirect URIs → Add: https://blue-y.blueonion.today/admin/auth/google/callback',
      '6. Click Create — copy the Client ID and Client Secret → paste here',
      '7. Save credentials here — SSO login buttons appear immediately (no restart needed)',
    ],
    links: [
      { label: 'Google Cloud Console', url: 'https://console.cloud.google.com/apis/credentials' },
      { label: 'Google OAuth Docs', url: 'https://developers.google.com/identity/openid-connect/openid-connect' },
    ],
  },
  bitbucket: {
    steps: [
      '⚠ App passwords were deprecated on Sep 9, 2025 — use API tokens instead (disabled June 9, 2026).',
      '1. Go to id.atlassian.com → Manage profile → Security → API tokens (or click the link below)',
      '2. Click "Create API token with scope" — give it a name (e.g. "BLUE.Y Dashboard") and set an expiry',
      '3. On the Select scopes page, search "repository" → tick write:repository:bitbucket (includes read)',
      '4. Also search "pipeline" → tick read:pipeline:bitbucket (needed for Live Build Monitor)',
      '5. Click Next → Create token — copy it immediately (shown only once) → paste as API Token above',
      '6. Set Workspace slug to your Bitbucket workspace URL slug (e.g. "blue-onion")',
      '7. Once saved, Smart Rebuild will push an empty commit to trigger your pipeline, and the Live Build Monitor will poll status live',
    ],
    links: [
      { label: 'Bitbucket API Tokens', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' },
      { label: 'Bitbucket Pipelines Docs', url: 'https://support.atlassian.com/bitbucket-cloud/docs/get-started-with-bitbucket-pipelines/' },
    ],
  },
  github: {
    steps: [
      '1. Go to GitHub → Settings (top-right avatar) → Developer settings → Personal access tokens → Tokens (classic)',
      '2. Click "Generate new token (classic)" — give it a Note (e.g. "BLUE.Y Dashboard")',
      '3. Set an expiration → under Select scopes, tick "repo" (full control of private repositories)',
      '4. Click Generate token → copy immediately (shown only once) → paste as Personal Access Token above',
      '5. Set Organisation / User to your GitHub org slug or username (e.g. "bluey-ai")',
      '6. Once saved, the Smart Rebuild button will push an empty commit to trigger your GitHub Actions workflow',
      'ℹ Fine-grained tokens also work: grant Contents: Read and write on the target repositories',
    ],
    links: [
      { label: 'GitHub Token Settings', url: 'https://github.com/settings/tokens' },
      { label: 'GitHub Actions Docs', url: 'https://docs.github.com/en/actions/using-workflows/triggering-a-workflow' },
    ],
  },
};

export default function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [readOnly, setReadOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ id: string; type: 'ok' | 'err'; text: string } | null>(null);
  const [showGuide, setShowGuide] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getIntegrations();
      setIntegrations(r.integrations);
      setReadOnly(r.readOnly);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (intg: Integration) => {
    const vals: Record<string, string> = {};
    intg.fields.forEach(f => { vals[f.key] = f.value; });
    setEditValues(vals);
    setEditing(intg.id);
    setMsg(null);
  };

  const cancelEdit = () => { setEditing(null); setEditValues({}); };

  const handleTest = async (id: string) => {
    setTestStates(prev => ({ ...prev, [id]: { loading: true } }));
    try {
      const r = await testIntegration(id);
      setTestStates(prev => ({ ...prev, [id]: { loading: false, status: r.status, message: r.message } }));
    } catch (e: any) {
      setTestStates(prev => ({ ...prev, [id]: { loading: false, status: 'failed', message: e.message } }));
    }
  };

  const handleSave = async (id: string) => {
    setSaving(true); setMsg(null);
    try {
      await saveIntegration(id, editValues);
      setMsg({ id, type: 'ok', text: 'Saved successfully.' });
      setEditing(null);
      await load();
    } catch (e: any) {
      setMsg({ id, type: 'err', text: e.message });
    } finally { setSaving(false); }
  };

  const renderCard = (intg: Integration) => {
    const isEditing = editing === intg.id;
    const colorClass = PLATFORM_COLOR[intg.icon] ?? 'text-[#8b949e] bg-[#21262d] border-[#30363d]';
    const ts = testStates[intg.id];
    return (
      <Card key={intg.id}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={clsx('w-9 h-9 rounded-lg border flex items-center justify-center text-sm font-bold', colorClass)}>
              {PLATFORM_LABEL[intg.icon] ?? intg.label.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="text-sm font-semibold text-[#e6edf3]">{intg.label}</div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {intg.enabled
                  ? <><CheckCircle size={10} className="text-[#3fb950]" /><span className="text-[10px] text-[#3fb950]">Configured</span></>
                  : <><XCircle size={10} className="text-[#6e7681]" /><span className="text-[10px] text-[#6e7681]">Not configured</span></>
                }
                {ts && !ts.loading && ts.status && (
                  <span className={clsx(
                    'flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium border',
                    ts.status === 'connected'      ? 'text-[#3fb950] bg-[#3fb950]/10 border-[#3fb950]/30' :
                    ts.status === 'not_configured' ? 'text-[#8b949e] bg-[#21262d] border-[#30363d]' :
                                                     'text-[#f85149] bg-[#f85149]/10 border-[#f85149]/30'
                  )}>
                    {ts.status === 'connected'
                      ? <><CheckCircle size={8} /> Live</>
                      : ts.status === 'not_configured'
                      ? <><XCircle size={8} /> Not configured</>
                      : <><XCircle size={8} /> Unreachable</>
                    }
                  </span>
                )}
                {ts?.loading && (
                  <span className="flex items-center gap-0.5 text-[9px] text-[#6e7681]">
                    <Loader2 size={8} className="animate-spin" /> Testing…
                  </span>
                )}
              </div>
            </div>
          </div>
          {!readOnly && !isEditing && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleTest(intg.id)}
                disabled={ts?.loading}
                title={ts?.message}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff]/50 transition-colors disabled:opacity-40"
              >
                <Zap size={9} /> Test
              </button>
              <button
                onClick={() => startEdit(intg)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#58a6ff] transition-colors"
              >
                <Edit2 size={10} /> Edit
              </button>
            </div>
          )}
          {isEditing && (
            <div className="flex gap-2">
              <button
                onClick={cancelEdit}
                className="p-1.5 rounded text-[#8b949e] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors"
              >
                <X size={13} />
              </button>
              <button
                onClick={() => handleSave(intg.id)}
                disabled={saving}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white transition-colors disabled:opacity-50"
              >
                <Save size={10} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2.5">
          {intg.fields.map(f => (
            <div key={f.key}>
              <label className="block text-[10px] text-[#6e7681] mb-0.5">{f.label}</label>
              {isEditing ? (
                <input
                  type={f.type === 'password' ? 'password' : 'text'}
                  value={editValues[f.key] ?? ''}
                  onChange={e => setEditValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.hasValue ? '(unchanged)' : `Enter ${f.label.toLowerCase()}`}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
                />
              ) : (
                <div className="text-xs font-mono text-[#8b949e] bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 truncate">
                  {f.value || <span className="text-[#6e7681] italic">not set</span>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Test result message */}
        {ts && !ts.loading && ts.message && (
          <p className={clsx(
            'mt-3 text-[10px] px-2.5 py-1.5 rounded border',
            ts.status === 'connected'
              ? 'text-[#3fb950] bg-[#3fb950]/5 border-[#3fb950]/20'
              : 'text-[#f85149] bg-[#f85149]/5 border-[#f85149]/20',
          )}>
            {ts.message}
          </p>
        )}

        {/* Setup guide */}
        {SETUP_GUIDES[intg.id] && (
          <div className="mt-3 border-t border-[#21262d] pt-3">
            <button
              onClick={() => setShowGuide(showGuide === intg.id ? null : intg.id)}
              className="flex items-center gap-1.5 text-[10px] text-[#6e7681] hover:text-[#8b949e] transition-colors"
            >
              <HelpCircle size={11} />
              How to get these credentials
              {showGuide === intg.id ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
            {showGuide === intg.id && (
              <div className="mt-2 space-y-1.5">
                {SETUP_GUIDES[intg.id].steps.map((step, i) => (
                  <p key={i} className="text-[10px] text-[#8b949e] leading-relaxed">{step}</p>
                ))}
                <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[#21262d]">
                  {SETUP_GUIDES[intg.id].links.map(l => (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-[#58a6ff] hover:underline"
                    >
                      <ExternalLink size={9} />
                      {l.label}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {msg?.id === intg.id && (
          <p className={clsx('mt-3 text-xs', msg.type === 'ok' ? 'text-[#3fb950]' : 'text-[#f85149]')}>
            {msg.text}
          </p>
        )}
      </Card>
    );
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Integrations</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">
            {readOnly ? 'View integration status — contact SuperAdmin to edit credentials' : 'Configure messaging platform integrations'}
          </p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {loading ? (
        <p className="text-center text-sm text-[#6e7681] py-10">Loading…</p>
      ) : (
        <>
          {/* Messaging integrations */}
          <div>
            <h2 className="text-xs font-semibold text-[#6e7681] uppercase tracking-wider mb-3">Messaging Platforms</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {integrations.filter(i => !i.id.endsWith('-sso')).map(intg => renderCard(intg))}
            </div>
          </div>
          {/* SSO integrations */}
          <div>
            <h2 className="text-xs font-semibold text-[#6e7681] uppercase tracking-wider mb-3">Single Sign-On (SSO)</h2>
            <p className="text-xs text-[#8b949e] mb-3">Configure identity providers so invited users can sign in. Changes take effect immediately — no restart needed.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {integrations.filter(i => i.id.endsWith('-sso')).map(intg => renderCard(intg))}
            </div>
          </div>
          {/* CI/CD integrations */}
          <div>
            <h2 className="text-xs font-semibold text-[#6e7681] uppercase tracking-wider mb-3">CI/CD Providers</h2>
            <p className="text-xs text-[#8b949e] mb-3">
              Connect a CI provider so the <strong className="text-[#e6edf3]">Smart Rebuild</strong> button can trigger a fresh image build directly from a pod's detail panel.
              Configure Bitbucket or GitHub (or both — Bitbucket takes priority). Jenkins support coming soon.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {integrations.filter(i => i.id === 'bitbucket' || i.id === 'github').map(intg => renderCard(intg))}
            </div>
          </div>
        </>
      )}

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e]">
        ℹ Changes are written to the <code className="font-mono bg-[#0d1117] px-1 rounded">blue-y-config</code> ConfigMap and applied on the next bot hot-reload cycle (~30s).
      </div>
    </div>
  );
}
