// BLY-63: Web terminal — exec into a pod via WebSocket + xterm.js
import { useEffect, useRef, useCallback } from 'react';
import { X, Terminal as TerminalIcon } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  namespace: string;
  pod: string;
  container?: string;
  onClose: () => void;
}

function getWsUrl(namespace: string, pod: string, container: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ namespace, pod });
  if (container) params.set('container', container);
  return `${proto}//${window.location.host}/admin/ws/exec?${params}`;
}

export default function PodTerminal({ namespace, pod, container = '', onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitAddonRef  = useRef<FitAddon | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Init terminal
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor:     '#58a6ff',
        black:      '#21262d',
        brightBlack:'#484f58',
        blue:       '#58a6ff',
        brightBlue: '#79c0ff',
        cyan:       '#39d353',
        green:      '#3fb950',
        magenta:    '#bc8cff',
        red:        '#f85149',
        white:      '#b1bac4',
        brightWhite:'#e6edf3',
        yellow:     '#d29922',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current     = term;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket
    const ws = new WebSocket(getWsUrl(namespace, pod, container));
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln('\x1b[32mConnected to ' + namespace + '/' + pod + '\x1b[0m');
      term.writeln('\x1b[90mType commands below. Press Ctrl+D to exit.\x1b[0m\r\n');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') term.write(msg.data);
        else if (msg.type === 'error') term.writeln('\r\n\x1b[31m' + msg.data + '\x1b[0m');
      } catch { term.write(ev.data); }
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m');
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[WebSocket error — check pod status]\x1b[0m');
    };

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Resize handler
    const onResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      ws.close();
      term.dispose();
    };
  }, [namespace, pod, container]);

  useEffect(() => {
    const cleanup = connect();
    return () => {
      cleanup?.();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-full max-w-5xl mx-4 bg-[#0d1117] rounded-xl border border-[#30363d] shadow-2xl flex flex-col overflow-hidden" style={{ height: '75vh' }}>
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 bg-[#161b22] border-b border-[#30363d] shrink-0">
          <TerminalIcon size={14} className="text-[#58a6ff]" />
          <span className="text-sm font-semibold text-[#e6edf3]">Terminal</span>
          <span className="text-xs font-mono text-[#8b949e]">
            {namespace} / <span className="text-[#58a6ff]">{pod}</span>
            {container && <span className="text-[#6e7681]"> / {container}</span>}
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* xterm container */}
        <div ref={containerRef} className="flex-1 overflow-hidden p-2" />
      </div>
    </div>
  );
}
