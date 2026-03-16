import { useEffect, useState } from 'react';
import { LayoutDashboard, AlertTriangle, Server, Layers, Terminal, Users, Settings, LogOut, Wifi, WifiOff, Menu, X } from 'lucide-react';
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
  { id: 'overview',    label: 'Overview',     Icon: LayoutDashboard },
  { id: 'incidents',   label: 'Incidents',    Icon: AlertTriangle },
  { id: 'cluster',     label: 'Cluster',      Icon: Server },
  { id: 'deployments', label: 'Deployments',  Icon: Layers },
  { id: 'logs',        label: 'Log Explorer', Icon: Terminal },
  { id: 'users',       label: 'Users',        Icon: Users },
  { id: 'config',      label: 'Config',       Icon: Settings },
];

const PLATFORM_COLOR: Record<string, string> = {
  telegram:  'text-[#0088cc]',
  slack:     'text-[#4a154b]',
  teams:     'text-[#6264a7]',
  whatsapp:  'text-[#25d366]',
  microsoft: 'text-[#00a4ef]',
  google:    'text-[#ea4335]',
};

export default function Layout({ page, onNavigate, children }: Props) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [online, setOnline] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  // Mobile: sidebar hidden by default, shown as overlay
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    getMe().then(setMe).catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch('/admin/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/admin/login';
  };

  const navigate = (id: Page) => {
    onNavigate(id);
    setMobileOpen(false); // close mobile drawer on navigate
  };

  const SidebarContent = (
    <>
      {/* Logo + collapse toggle */}
      <div className="flex items-center gap-3 px-3 py-4 border-b border-[#30363d]">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="shrink-0 hover:opacity-80 transition-opacity hidden lg:block"
        >
          <Logo size={28} />
        </button>
        {/* Mobile: just the logo, no collapse */}
        <div className="shrink-0 lg:hidden">
          <Logo size={28} />
        </div>
        {(!collapsed || mobileOpen) && (
          <div className="flex-1 min-w-0">
            <div className="text-gradient font-bold text-sm leading-tight">BLUE.Y</div>
            <div className="text-[#6e7681] text-[10px] uppercase tracking-widest">Admin</div>
          </div>
        )}
        {/* Mobile close button */}
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden ml-auto p-1 text-[#8b949e] hover:text-[#e6edf3]"
        >
          <X size={16} />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 space-y-0.5 px-1.5 overflow-y-auto">
        {NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => navigate(id)}
            className={clsx(
              'w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md text-sm transition-all',
              page === id
                ? 'bg-[#21262d] text-[#58a6ff] font-medium'
                : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]',
            )}
            title={collapsed && !mobileOpen ? label : undefined}
          >
            <Icon size={16} className="shrink-0" />
            {(!collapsed || mobileOpen) && <span className="truncate">{label}</span>}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-[#30363d] p-2 space-y-1">
        {/* Connection status */}
        <div className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded text-xs',
          online ? 'text-[#3fb950]' : 'text-[#f85149]')}>
          {online ? <Wifi size={12} /> : <WifiOff size={12} />}
          {(!collapsed || mobileOpen) && (online ? 'Live' : 'Offline')}
        </div>

        {/* User */}
        {me && (
          <div className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-[#8b949e]',
            (!collapsed || mobileOpen) && 'bg-[#0d1117]')}>
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#58a6ff] to-[#bc8cff] flex items-center justify-center text-[9px] text-white font-bold shrink-0">
              {me.name.charAt(0).toUpperCase()}
            </div>
            {(!collapsed || mobileOpen) && (
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
          title={collapsed && !mobileOpen ? 'Logout' : undefined}
        >
          <LogOut size={12} className="shrink-0" />
          {(!collapsed || mobileOpen) && 'Logout'}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-screen">
      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      <aside className={clsx(
        'hidden lg:flex flex-col bg-[#161b22] border-r border-[#30363d] transition-all duration-200 shrink-0',
        collapsed ? 'w-14' : 'w-56',
      )}>
        {SidebarContent}
      </aside>

      {/* Mobile sidebar (drawer overlay) */}
      <aside className={clsx(
        'fixed inset-y-0 left-0 z-30 flex flex-col w-64 bg-[#161b22] border-r border-[#30363d] transition-transform duration-200 lg:hidden',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        {SidebarContent}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-[#161b22] border-b border-[#30363d] shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"
          >
            <Menu size={18} />
          </button>
          <Logo size={22} />
          <span className="text-gradient font-bold text-sm">BLUE.Y</span>
          <span className="text-[#6e7681] text-[10px] uppercase tracking-widest">Admin</span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className={clsx('w-1.5 h-1.5 rounded-full', online ? 'bg-[#3fb950]' : 'bg-[#f85149]')} />
            <span className={clsx('text-[10px]', online ? 'text-[#3fb950]' : 'text-[#f85149]')}>
              {online ? 'Live' : 'Offline'}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-[#0d1117]">
          <OnlineContext.Provider value={{ online, setOnline }}>
            {children}
          </OnlineContext.Provider>
        </main>
      </div>
    </div>
  );
}

// Simple context for stream online state
import { createContext, useContext } from 'react';
export const OnlineContext = createContext<{ online: boolean; setOnline: (v: boolean) => void }>({
  online: true, setOnline: () => {},
});
export const useOnline = () => useContext(OnlineContext);
