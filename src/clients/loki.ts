import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface LogStats {
  totalLines: number;
  errorLines: number;
  warnLines: number;
  errorRate: number; // percentage
}

export interface ErrorPattern {
  pattern: string;
  count: number;
  sample: string; // first occurrence
}

export class LokiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.loki.baseUrl;
  }

  // Query recent logs for a pod
  async queryPodLogs(namespace: string, pod: string, limit = 100, since = '1h'): Promise<string[]> {
    try {
      const query = `{namespace="${namespace}", pod=~"${pod}.*"}`;
      const response = await axios.get(`${this.baseUrl}/loki/api/v1/query_range`, {
        params: {
          query,
          limit,
          start: this.sinceToNano(since),
          end: `${Date.now()}000000`, // nanoseconds
          direction: 'backward',
        },
        timeout: 10000,
      });

      const streams = response.data?.data?.result || [];
      const lines: string[] = [];
      for (const stream of streams) {
        for (const [, line] of (stream.values || [])) {
          lines.push(line);
        }
      }
      return lines;
    } catch (err) {
      logger.error(`[Loki] Failed to query pod logs: ${err}`);
      return [];
    }
  }

  // Get error logs for a pod (filtered by error/exception/fatal patterns)
  async getErrorLogs(namespace: string, pod: string, since = '1h', limit = 50): Promise<string[]> {
    try {
      const query = `{namespace="${namespace}", pod=~"${pod}.*"} |~ "(?i)(error|exception|fatal|panic|oom|timeout|refused|failed|stacktrace|NullPointer|OutOfMemory)"`;
      const response = await axios.get(`${this.baseUrl}/loki/api/v1/query_range`, {
        params: {
          query,
          limit,
          start: this.sinceToNano(since),
          end: `${Date.now()}000000`,
          direction: 'backward',
        },
        timeout: 10000,
      });

      const streams = response.data?.data?.result || [];
      const lines: string[] = [];
      for (const stream of streams) {
        for (const [, line] of (stream.values || [])) {
          lines.push(line);
        }
      }
      return lines;
    } catch (err) {
      logger.error(`[Loki] Failed to query error logs: ${err}`);
      return [];
    }
  }

  // Get log stats (total, errors, warnings, error rate) for a pod
  async getLogStats(namespace: string, pod: string, since = '1h'): Promise<LogStats | null> {
    try {
      const start = this.sinceToNano(since);
      const end = `${Date.now()}000000`;

      const [totalRes, errorRes, warnRes] = await Promise.all([
        axios.get(`${this.baseUrl}/loki/api/v1/query`, {
          params: { query: `sum(count_over_time({namespace="${namespace}", pod=~"${pod}.*"} [${since}]))`, time: `${Date.now() / 1000}` },
          timeout: 10000,
        }).catch(() => null),
        axios.get(`${this.baseUrl}/loki/api/v1/query`, {
          params: { query: `sum(count_over_time({namespace="${namespace}", pod=~"${pod}.*"} |~ "(?i)(error|exception|fatal|panic|oom)" [${since}]))`, time: `${Date.now() / 1000}` },
          timeout: 10000,
        }).catch(() => null),
        axios.get(`${this.baseUrl}/loki/api/v1/query`, {
          params: { query: `sum(count_over_time({namespace="${namespace}", pod=~"${pod}.*"} |~ "(?i)(warn)" [${since}]))`, time: `${Date.now() / 1000}` },
          timeout: 10000,
        }).catch(() => null),
      ]);

      const extractValue = (res: unknown): number => {
        const data = (res as { data?: { data?: { result?: { value?: [number, string] }[] } } })?.data?.data?.result;
        if (Array.isArray(data) && data.length > 0 && data[0].value) {
          return parseFloat(data[0].value[1]) || 0;
        }
        return 0;
      };

      const totalLines = extractValue(totalRes);
      const errorLines = extractValue(errorRes);
      const warnLines = extractValue(warnRes);
      const errorRate = totalLines > 0 ? (errorLines / totalLines) * 100 : 0;

      return { totalLines, errorLines, warnLines, errorRate };
    } catch (err) {
      logger.error(`[Loki] Failed to get log stats: ${err}`);
      return null;
    }
  }

  // Get error patterns (grouped) for a namespace in the last hour
  async getErrorPatterns(namespace: string, since = '1h', limit = 200): Promise<ErrorPattern[]> {
    const errors = await this.getErrorLogs(namespace, '.*', since, limit);
    if (errors.length === 0) return [];

    // Group errors by pattern (first 80 chars, normalized)
    const patterns = new Map<string, { count: number; sample: string }>();
    for (const line of errors) {
      // Normalize: strip timestamps, hex addresses, uuids for grouping
      const normalized = line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TIME>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
        .replace(/0x[0-9a-f]+/gi, '<ADDR>')
        .replace(/\d{10,}/g, '<NUM>')
        .substring(0, 100);

      const existing = patterns.get(normalized);
      if (existing) {
        existing.count++;
      } else {
        patterns.set(normalized, { count: 1, sample: line.substring(0, 300) });
      }
    }

    // Sort by frequency
    return [...patterns.entries()]
      .map(([pattern, { count, sample }]) => ({ pattern, count, sample }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // top 10 patterns
  }

  // Get log volume spike detection (are errors increasing?)
  async getErrorTrend(namespace: string, pod: string): Promise<'increasing' | 'stable' | 'decreasing' | 'unknown'> {
    try {
      // Compare error count in last 15min vs previous 15min
      const recent = await axios.get(`${this.baseUrl}/loki/api/v1/query`, {
        params: {
          query: `sum(count_over_time({namespace="${namespace}", pod=~"${pod}.*"} |~ "(?i)(error|exception|fatal)" [15m]))`,
          time: `${Date.now() / 1000}`,
        },
        timeout: 10000,
      }).catch(() => null);

      const previous = await axios.get(`${this.baseUrl}/loki/api/v1/query`, {
        params: {
          query: `sum(count_over_time({namespace="${namespace}", pod=~"${pod}.*"} |~ "(?i)(error|exception|fatal)" [15m]))`,
          time: `${(Date.now() - 15 * 60 * 1000) / 1000}`,
        },
        timeout: 10000,
      }).catch(() => null);

      const extractVal = (res: unknown): number => {
        const data = (res as { data?: { data?: { result?: { value?: [number, string] }[] } } })?.data?.data?.result;
        return Array.isArray(data) && data.length > 0 ? parseFloat(data[0].value?.[1] || '0') : 0;
      };

      const recentCount = extractVal(recent);
      const prevCount = extractVal(previous);

      if (recentCount === 0 && prevCount === 0) return 'stable';
      if (prevCount === 0 && recentCount > 0) return 'increasing';
      if (recentCount > prevCount * 1.5) return 'increasing';
      if (recentCount < prevCount * 0.5) return 'decreasing';
      return 'stable';
    } catch {
      return 'unknown';
    }
  }

  // Format log stats for display
  formatStats(stats: LogStats, errorTrend: string): string {
    const trendIcon = errorTrend === 'increasing' ? '📈 INCREASING' :
      errorTrend === 'decreasing' ? '📉 Decreasing' : '➡️ Stable';

    return [
      `Total log lines (1h): ${stats.totalLines.toLocaleString()}`,
      `Errors: ${stats.errorLines} (${stats.errorRate.toFixed(1)}%)`,
      `Warnings: ${stats.warnLines}`,
      `Error trend: ${trendIcon}`,
    ].join('\n');
  }

  // Format error patterns for display
  formatPatterns(patterns: ErrorPattern[]): string {
    if (patterns.length === 0) return 'No error patterns found.';
    return patterns.map((p, i) =>
      `${i + 1}. [${p.count}x] ${p.sample.substring(0, 200)}`,
    ).join('\n\n');
  }

  private sinceToNano(since: string): string {
    const match = since.match(/^(\d+)([mhd])$/);
    if (!match) return `${(Date.now() - 3600000)}000000`; // default 1h
    const [, val, unit] = match;
    const ms = parseInt(val) * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
    return `${(Date.now() - ms)}000000`;
  }
}
