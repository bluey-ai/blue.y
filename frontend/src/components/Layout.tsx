import { useEffect, useState } from 'react';
import { LayoutDashboard, AlertTriangle, Server, Layers, Terminal, Users, Settings, LogOut, Wifi, WifiOff } from 'lucide-react';
import type { Page } from '../App';
import Logo from './Logo';
import { getMe } from '../api';
import type { MeResponse } from '../api';
import clsx from 'clsx';

interface Props {
  page: Page;
  onNavigate: (p: Page) => void;
  children: React.ReactNode;
}

const NAV: { id: Page; label: string; Icon: React.ElementType }[] = [
  { id: 'overview',    label: 'Overview',    Icon: LayoutDashboard },
  { id: 'incidents',   label: 'Incidents',   Icon: AlertTriangle },
  { id: 'cluster',     label: 'Cluster',     Icon: Server },
  { id: 'deployments', label: 'Deployments', Icon: Layers },
  { id: 'logs',        label: 'Log Explorer', Icon: Terminal },
  { id: 'users',       label: 'Users',       Icon: Users },
  { id: 'config',      label: 'Config',      Icon: Settings },
];

const PLATFORM_COLOR: Record<string, string> = {
  telegram: 'text-[#0088cc]',
  slack: 'text-[#4a154b]',
  teams: 'text-[#6264a7]',
  whatsapp: 'text-[#25d366]',
};

export default function Layout({ page, onNavigate, children }: Props) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [online, setOnline] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    getMe().then(setMe).catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch('/admin/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/admin/login';
  };

  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar */}
      <aside className={clsx(
        'flex flex-col bg-[#161b22] border-r border-[#30363d] transition-all duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}>
        {/* Logo + title */}
        <div className="flex items-center gap-3 px-3 py-4 border-b border-[#30363d]">
          <button onClick={() => setCollapsed(c => !c)} className="shrink-0 hover:opacity-80 transition-opacity">
            <Logo size={28} />
          </button>
          {!collapsed && (
            <div>
              <div className="text-gradient font-bold text-sm leading-tight">BLUE.Y</div>
              <div className="text-[#6e7681] text-[10px] uppercase tracking-widest">Admin</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 space-y-0.5 px-1.5">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={clsx(
                'w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-all',
                page === id
                  ? 'bg-[#21262d] text-[#58a6ff] font-medium'
                  : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]',
              )}
              title={collapsed ? label : undefined}
            >
              <Icon size={16} className="shrink-0" />
              {!collapsed && label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-[#30363d] p-2 space-y-1">
          {/* Connection status */}
          <div className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded text-xs',
            online ? 'text-[#3fb950]' : 'text-[#f85149]')}>
            {online ? <Wifi size={12} /> : <WifiOff size={12} />}
            {!collapsed && (online ? 'Live' : 'Offline')}
          </div>

          {/* User */}
          {me && (
            <div className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-[#8b949e]',
              !collapsed && 'bg-[#0d1117]')}>
              <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#58a6ff] to-[#bc8cff] flex items-center justify-center text-[9px] text-white font-bold shrink-0">
                {me.name.charAt(0).toUpperCase()}
              </div>
              {!collapsed && (
                <div className="min-w-0">
                  <div className="truncate text-[#e6edf3] text-xs">{me.name}</div>
                  <div className={clsx('text-[10px] capitalize', PLATFORM_COLOR[me.platform] ?? 'text-[#8b949e]')}>{me.platform}</div>
                </div>
              )}
            </div>
          )}

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-2.5 py-1.5 rounded text-xs text-[#f85149] hover:bg-[#21262d] transition-colors"
            title={collapsed ? 'Logout' : undefined}
          >
            <LogOut size={12} className="shrink-0" />
            {!collapsed && 'Logout'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-[#0d1117]">
        <OnlineContext.Provider value={{ online, setOnline }}>
          {children}
        </OnlineContext.Provider>
      </main>
    </div>
  );
}

// Simple context for stream online state
import { createContext, useContext } from 'react';
export const OnlineContext = createContext<{ online: boolean; setOnline: (v: boolean) => void }>({
  online: true, setOnline: () => {},
});
export const useOnline = () => useContext(OnlineContext);
