// BLY-65: Inline pod log viewer modal — read-only SSE log tail
import { useEffect, useRef, useState, useCallback } from 'react';
import { X, ScrollText, Copy, Check, RefreshCw, ChevronDown } from 'lucide-react';
import { streamLogs } from '../api';
import clsx from 'clsx';

interface Props {
  namespace: string;
  pod: string;
  container: string;
  containers: string[]; // all containers in this pod
  onClose: () => void;
}

const TAIL_OPTIONS = [100, 200, 500, 1000];
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');

export default function PodLogsViewer({ namespace, pod, container: initContainer, containers, onClose }: Props) {
  const [container, setContainer] = useState(initContainer);
  const [lines, setLines]         = useState<string[]>([]);
  const [tail, setTail]           = useState(200);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied]       = useState(false);
  const [showContainerMenu, setShowContainerMenu] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef     = useRef<EventSource | null>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  const start = useCallback(() => {
    esRef.current?.close();
    setLines([]);
    const es = streamLogs(namespace, pod, container, tail, (line) => {
      setLines(prev => [...prev, stripAnsi(line)]);
    });
    esRef.current = es;
  }, [namespace, pod, container, tail]);

  useEffect(() => {
    start();
    return () => { esRef.current?.close(); };
  }, [start]);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines]);

  const copy = () => {
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-5xl mx-4 bg-[#0d1117] rounded-xl border border-[#30363d] shadow-2xl flex flex-col" style={{ height: '75vh' }}>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-[#161b22] border-b border-[#30363d] shrink-0">
          <ScrollText size={14} className="text-[#3fb950]" />
          <span className="text-sm font-semibold text-[#e6edf3]">Logs</span>
          <span className="text-xs font-mono text-[#8b949e]">
            {namespace} / <span className="text-[#58a6ff]">{pod}</span>
          </span>

          {/* Container selector */}
          {containers.length > 1 ? (
            <div className="relative">
              <button
                onClick={() => setShowContainerMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors"
              >
                {container} <ChevronDown size={9} />
              </button>
              {showContainerMenu && (
                <div className="absolute top-full left-0 mt-1 bg-[#161b22] border border-[#30363d] rounded shadow-xl z-10 min-w-[160px] py-1">
                  {containers.map(c => (
                    <button
                      key={c}
                      onClick={() => { setContainer(c); setShowContainerMenu(false); }}
                      className={clsx('w-full text-left px-3 py-1.5 text-xs hover:bg-[#21262d] transition-colors font-mono',
                        c === container ? 'text-[#58a6ff]' : 'text-[#8b949e]'
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="text-[10px] font-mono text-[#6e7681]">{container}</span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {/* Tail selector */}
            <select
              value={tail}
              onChange={e => setTail(Number(e.target.value))}
              className="text-xs bg-[#21262d] border border-[#30363d] rounded px-2 py-0.5 text-[#8b949e] outline-none cursor-pointer"
            >
              {TAIL_OPTIONS.map(n => <option key={n} value={n}>{n} lines</option>)}
            </select>

            {/* Auto-scroll toggle */}
            <button
              onClick={() => setAutoScroll(v => !v)}
              title={autoScroll ? 'Auto-scroll on — click to pause' : 'Auto-scroll off — click to resume'}
              className={clsx(
                'px-2 py-0.5 rounded text-[10px] border transition-colors',
                autoScroll
                  ? 'text-[#3fb950] bg-[#3fb950]/10 border-[#3fb950]/20 hover:bg-[#3fb950]/20'
                  : 'text-[#8b949e] bg-[#21262d] border-[#30363d] hover:text-[#e6edf3]',
              )}
            >
              {autoScroll ? 'Live' : 'Paused'}
            </button>

            {/* Reload */}
            <button onClick={start} title="Reload" className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
              <RefreshCw size={12} />
            </button>

            {/* Copy */}
            <button onClick={copy} title="Copy all lines" className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
              {copied ? <Check size={12} className="text-[#3fb950]" /> : <Copy size={12} />}
            </button>

            {/* Close */}
            <button onClick={onClose} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Log output */}
        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
          {lines.length === 0 ? (
            <span className="text-[#6e7681]">Waiting for logs…</span>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="hover:bg-[#161b22] px-1 rounded whitespace-pre-wrap break-all text-[#8b949e]">
                {line || '\u00a0'}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div className="px-4 py-1.5 border-t border-[#21262d] shrink-0">
          <span className="text-[10px] text-[#6e7681]">{lines.length} lines — streaming live</span>
        </div>
      </div>
    </div>
  );
}
