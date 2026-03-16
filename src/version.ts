/**
 * Build version info — baked in at Docker build time via ARG/ENV.
 *
 * Consumed by:
 *   - /health HTTP endpoint (JSON)
 *   - /version Telegram command
 *   - Startup log line
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export interface VersionInfo {
  version: string;    // semver e.g. "1.1.0"
  commit: string;     // short git hash e.g. "5d1b71d"
  buildDate: string;  // ISO timestamp e.g. "2026-03-14T07:43:45Z"
  edition: string;    // 'community' | 'premium'
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const buildInfo: VersionInfo = {
  version:   process.env.BUILD_VERSION || readPackageVersion(),
  commit:    (process.env.BUILD_COMMIT || 'dev').slice(0, 8),
  buildDate: process.env.BUILD_DATE || 'unknown',
  edition:   process.env.BUILD_EDITION || 'community',
};

const START_MS = Date.now();

/** Human-readable uptime string e.g. "2h 15m" */
export function uptime(): string {
  const ms = Date.now() - START_MS;
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
