import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Edit2, Save, X, HelpCircle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { getIntegrations, saveIntegration } from '../api';
import type { Integration } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

const PLATFORM_COLOR: Record<string, string> = {
  telegram:  'text-[#0088cc] bg-[#0088cc]/10 border-[#0088cc]/20',
  slack:     'text-[#4a154b] bg-[#4a154b]/10 border-[#4a154b]/20',
  microsoft: 'text-[#6264a7] bg-[#6264a7]/10 border-[#6264a7]/20',
  whatsapp:  'text-[#25d366] bg-[#25d366]/10 border-[#25d366]/20',
};

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'TG', slack: 'SL', microsoft: 'MS', whatsapp: 'WA',
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.map(intg => {
            const isEditing = editing === intg.id;
            const colorClass = PLATFORM_COLOR[intg.icon] ?? 'text-[#8b949e] bg-[#21262d] border-[#30363d]';
            return (
              <Card key={intg.id}>
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={clsx('w-9 h-9 rounded-lg border flex items-center justify-center text-sm font-bold', colorClass)}>
                      {PLATFORM_LABEL[intg.icon] ?? intg.label.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-[#e6edf3]">{intg.label}</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        {intg.enabled
                          ? <><CheckCircle size={10} className="text-[#3fb950]" /><span className="text-[10px] text-[#3fb950]">Connected</span></>
                          : <><XCircle size={10} className="text-[#6e7681]" /><span className="text-[10px] text-[#6e7681]">Not configured</span></>
                        }
                      </div>
                    </div>
                  </div>
                  {!readOnly && !isEditing && (
                    <button
                      onClick={() => startEdit(intg)}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#58a6ff] transition-colors"
                    >
                      <Edit2 size={10} /> Edit
                    </button>
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
          })}
        </div>
      )}

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e]">
        ℹ Changes are written to the <code className="font-mono bg-[#0d1117] px-1 rounded">blue-y-config</code> ConfigMap and applied on the next bot hot-reload cycle (~30s).
      </div>
    </div>
  );
}
