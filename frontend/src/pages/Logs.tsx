import { useEffect, useState, useRef, useCallback } from 'react';
import { Terminal, Download, Bot, Play, Square, Trash2, Search } from 'lucide-react';
import { getLogPods, streamLogs, fetchLogs, analyzeLogs } from '../api';
import type { LogAnalysis } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import clsx from 'clsx';

const NAMESPACES = ['prod', 'dev', 'monitoring', 'doris', 'wordpress', 'kube-system'];
const TAIL_OPTIONS = [50, 100, 200, 500, 1000];

interface PodEntry { name: string; containers: string[] }

export default function Logs() {
  const [ns, setNs] = useState('prod');
  const [pods, setPods] = useState<PodEntry[]>([]);
  const [selectedPod, setSelectedPod] = useState('');
  const [selectedContainer, setSelectedContainer] = useState('');
  const [tail, setTail] = useState(200);
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [analysis, setAnalysis] = useState<LogAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [podFilter, setPodFilter] = useState('');

  const loadPods = useCallback(async (namespace: string) => {
    try {
      const r = await getLogPods(namespace);
      setPods(r.pods);
      setSelectedPod('');
      setSelectedContainer('');
      setLines([]);
      setAnalysis(null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadPods(ns); }, [ns, loadPods]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, autoScroll]);

  const stopStream = () => {
    esRef.current?.close();
    esRef.current = null;
    setStreaming(false);
  };

  const startStream = () => {
    if (!selectedPod) return;
    stopStream();
    setLines([]);
    setAnalysis(null);
    setStreaming(true);
    const es = streamLogs(ns, selectedPod, selectedContainer, tail,
      (line) => setLines(prev => [...prev.slice(-2000), line]),
      () => setStreaming(false),
    );
    esRef.current = es;
  };

  const loadSnapshot = async () => {
    if (!selectedPod) return;
    stopStream();
    setLines([]);
    setAnalysis(null);
    try {
      const r = await fetchLogs(ns, selectedPod, tail);
      setLines(r.lines);
    } catch (e: any) {
      setLines([`Error: ${e.message}`]);
    }
  };

  const doAnalyze = async () => {
    if (lines.length === 0) return;
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const logText = lines.slice(-300).join('\n');
      const r = await analyzeLogs(selectedPod, ns, logText);
      setAnalysis(r.analysis);
    } catch (e: any) {
      setAnalysis({ summary: `Analysis failed: ${e.message}`, issues: [], severity: 'warning' });
    } finally { setAnalyzing(false); }
  };

  const downloadLogs = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedPod}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearLogs = () => { setLines([]); setAnalysis(null); };

  const filteredLines = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  const containers = pods.find(p => p.name === selectedPod)?.containers ?? [];
  const filteredPods = podFilter ? pods.filter(p => p.name.includes(podFilter)) : pods;

  return (
    <div className="p-6 space-y-5 animate-fade-in h-[calc(100vh-0px)] flex flex-col">
      <div>
        <h1 className="text-xl font-bold text-[#e6edf3]">Log Explorer</h1>
        <p className="text-sm text-[#8b949e] mt-0.5">Live tail, snapshot, and AI-powered log analysis</p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Namespace */}
        <div className="flex items-center gap-1 flex-wrap">
          {NAMESPACES.map(n => (
            <button key={n} onClick={() => setNs(n)}
              className={clsx('px-2.5 py-1 rounded text-xs font-mono border transition-colors',
                ns === n ? 'bg-[#58a6ff]/20 text-[#58a6ff] border-[#58a6ff]/30' : 'bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] border-transparent'
              )}>{n}</button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Tail lines */}
          <select value={tail} onChange={e => setTail(Number(e.target.value))}
            className="bg-[#21262d] border border-[#30363d] text-[#8b949e] text-xs rounded px-2 py-1 outline-none focus:border-[#58a6ff]">
            {TAIL_OPTIONS.map(n => <option key={n} value={n}>last {n}</option>)}
          </select>

          {/* Actions */}
          <button onClick={loadSnapshot} disabled={!selectedPod}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors disabled:opacity-40 border border-[#30363d]">
            <Terminal size={11} /> Snapshot
          </button>

          {streaming
            ? <button onClick={stopStream}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[#f85149]/20 text-[#f85149] hover:bg-[#f85149]/30 transition-colors border border-[#f85149]/30">
                <Square size={11} /> Stop
              </button>
            : <button onClick={startStream} disabled={!selectedPod}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[#3fb950]/20 text-[#3fb950] hover:bg-[#3fb950]/30 transition-colors disabled:opacity-40 border border-[#3fb950]/30">
                <Play size={11} /> Live tail
              </button>
          }

          <button onClick={doAnalyze} disabled={lines.length === 0 || analyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[#bc8cff]/20 text-[#bc8cff] hover:bg-[#bc8cff]/30 transition-colors disabled:opacity-40 border border-[#bc8cff]/30">
            <Bot size={11} /> {analyzing ? 'Analyzing…' : 'AI Analyze'}
          </button>

          {lines.length > 0 && <>
            <button onClick={downloadLogs}
              className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors" title="Download logs">
              <Download size={13} />
            </button>
            <button onClick={clearLogs}
              className="p-1.5 rounded text-[#8b949e] hover:text-[#f85149] hover:bg-[#21262d] transition-colors" title="Clear">
              <Trash2 size={13} />
            </button>
          </>}
        </div>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Pod selector panel */}
        <div className="w-56 shrink-0 flex flex-col gap-2">
          <input type="text" placeholder="Filter pods…" value={podFilter} onChange={e => setPodFilter(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-xs font-mono text-[#e6edf3] outline-none focus:border-[#58a6ff] w-full" />
          <div className="flex-1 overflow-y-auto bg-[#161b22] border border-[#30363d] rounded-lg divide-y divide-[#21262d]">
            {filteredPods.length === 0 && (
              <div className="px-3 py-4 text-xs text-[#6e7681] text-center">No pods</div>
            )}
            {filteredPods.map(p => (
              <button key={p.name} onClick={() => { setSelectedPod(p.name); setSelectedContainer(p.containers[0] ?? ''); setLines([]); setAnalysis(null); }}
                className={clsx('w-full text-left px-3 py-2 text-xs hover:bg-[#21262d] transition-colors',
                  selectedPod === p.name ? 'bg-[#21262d] text-[#58a6ff]' : 'text-[#8b949e]'
                )}>
                <div className="font-mono truncate">{p.name}</div>
                {selectedPod === p.name && p.containers.length > 1 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.containers.map(c => (
                      <button key={c} onClick={e => { e.stopPropagation(); setSelectedContainer(c); }}
                        className={clsx('text-[10px] px-1.5 py-px rounded font-mono transition-colors',
                          selectedContainer === c ? 'bg-[#58a6ff]/20 text-[#58a6ff]' : 'bg-[#0d1117] text-[#6e7681] hover:text-[#8b949e]'
                        )}>{c}</button>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Log output + AI panel */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* AI analysis panel */}
          {(analysis || analyzing) && (
            <Card glow={analysis?.severity === 'critical' ? 'red' : analysis?.severity === 'warning' ? undefined : 'blue'}>
              <div className="flex items-center gap-2 mb-3">
                <Bot size={14} className="text-[#bc8cff]" />
                <span className="text-sm font-semibold text-[#e6edf3]">AI Analysis</span>
                {analysis && <Badge label={analysis.severity} variant={analysis.severity === 'critical' ? 'critical' : analysis.severity === 'warning' ? 'warning' : 'success'} size="xs" />}
              </div>
              {analyzing && <div className="text-sm text-[#8b949e] animate-pulse">DeepSeek is reading the logs…</div>}
              {analysis && (
                <div className="space-y-2 text-sm">
                  <p className="text-[#e6edf3]">{analysis.summary}</p>
                  {analysis.rootCause && (
                    <div>
                      <span className="text-[#d29922] font-semibold text-xs">Root Cause: </span>
                      <span className="text-[#8b949e] text-xs">{analysis.rootCause}</span>
                    </div>
                  )}
                  {analysis.issues.length > 0 && (
                    <ul className="space-y-1 mt-2">
                      {analysis.issues.map((issue, i) => (
                        <li key={i} className="text-xs text-[#8b949e] flex gap-2">
                          <span className="text-[#f85149] shrink-0">•</span>{issue}
                        </li>
                      ))}
                    </ul>
                  )}
                  {analysis.recommendation && (
                    <div className="mt-2 rounded bg-[#3fb950]/10 border border-[#3fb950]/20 px-3 py-2 text-xs text-[#3fb950]">
                      💡 {analysis.recommendation}
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* Log terminal */}
          <div className="flex-1 flex flex-col min-h-0 bg-[#0d1117] border border-[#30363d] rounded-lg overflow-hidden">
            {/* Terminal header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#f85149]/60" />
                <div className="w-3 h-3 rounded-full bg-[#d29922]/60" />
                <div className="w-3 h-3 rounded-full bg-[#3fb950]/60" />
              </div>
              <span className="font-mono text-xs text-[#6e7681] flex-1 truncate">
                {selectedPod ? `${ns}/${selectedPod}${selectedContainer ? ` [${selectedContainer}]` : ''}` : 'no pod selected'}
              </span>
              {streaming && (
                <div className="flex items-center gap-1.5 text-[10px] text-[#3fb950]">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse" />
                  LIVE
                </div>
              )}
              <span className="text-[10px] text-[#6e7681]">{filteredLines.length} lines</span>
              {/* Inline search */}
              <div className="flex items-center gap-1.5 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5">
                <Search size={10} className="text-[#6e7681]" />
                <input type="text" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                  className="bg-transparent text-[10px] font-mono text-[#e6edf3] outline-none w-24 placeholder:text-[#6e7681]" />
              </div>
              <label className="flex items-center gap-1 text-[10px] text-[#6e7681] cursor-pointer">
                <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="w-3 h-3 accent-[#58a6ff]" />
                Auto-scroll
              </label>
            </div>

            {/* Log lines */}
            <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] space-y-px leading-relaxed">
              {filteredLines.length === 0 && (
                <div className="text-[#6e7681] text-center py-8">
                  {selectedPod ? 'Click Snapshot or Live tail to load logs.' : 'Select a pod from the list to get started.'}
                </div>
              )}
              {filteredLines.map((line, i) => (
                <LogLine key={i} text={line} search={search} />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogLine({ text, search }: { text: string; search: string }) {
  const isError = /error|exception|fatal|failed|panic/i.test(text);
  const isWarn = /warn|warning/i.test(text);
  const isDebug = /debug/i.test(text);

  const color = isError ? 'text-[#f85149]' : isWarn ? 'text-[#d29922]' : isDebug ? 'text-[#6e7681]' : 'text-[#e6edf3]';

  if (search) {
    const idx = text.toLowerCase().indexOf(search.toLowerCase());
    if (idx >= 0) {
      return (
        <div className={clsx('whitespace-pre-wrap break-all', color)}>
          {text.slice(0, idx)}
          <mark className="bg-[#d29922]/40 text-[#d29922] rounded-sm">{text.slice(idx, idx + search.length)}</mark>
          {text.slice(idx + search.length)}
        </div>
      );
    }
  }

  return <div className={clsx('whitespace-pre-wrap break-all', color)}>{text}</div>;
}
