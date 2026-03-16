// @premium — BlueOnion internal only.
import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface IncidentRow {
  id: number;
  ts: string;
  severity: string;
  namespace: string;
  pod: string;
  monitor: string;
  title: string;
  message: string;
  ai_diagnosis: string | null;
}

let db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (db) return db;
  const dbPath = config.admin.dbPath;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL DEFAULT (datetime('now')),
      severity     TEXT    NOT NULL DEFAULT 'warning',
      namespace    TEXT    NOT NULL DEFAULT '',
      pod          TEXT    NOT NULL DEFAULT '',
      monitor      TEXT    NOT NULL DEFAULT '',
      title        TEXT    NOT NULL DEFAULT '',
      message      TEXT    NOT NULL DEFAULT '',
      ai_diagnosis TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_ts       ON incidents(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_ns       ON incidents(namespace);
  `);
  logger.info(`[admin] SQLite DB opened: ${dbPath}`);
  return db;
}

export function insertIncident(row: Omit<IncidentRow, 'id' | 'ts'>): void {
  openDb().prepare(`
    INSERT INTO incidents (severity, namespace, pod, monitor, title, message, ai_diagnosis)
    VALUES (@severity, @namespace, @pod, @monitor, @title, @message, @ai_diagnosis)
  `).run(row);
}

export function queryIncidents(opts: {
  limit?: number;
  severity?: string;
  namespace?: string;
  monitor?: string;
  search?: string;
}): IncidentRow[] {
  let sql = 'SELECT * FROM incidents WHERE 1=1';
  const params: Record<string, string | number> = {};
  if (opts.severity)  { sql += ' AND severity  = @severity';  params.severity  = opts.severity; }
  if (opts.namespace) { sql += ' AND namespace = @namespace'; params.namespace = opts.namespace; }
  if (opts.monitor)   { sql += ' AND monitor   = @monitor';   params.monitor   = opts.monitor; }
  if (opts.search)    { sql += ' AND (title LIKE @q OR message LIKE @q OR ai_diagnosis LIKE @q)'; params.q = `%${opts.search}%`; }
  sql += ' ORDER BY id DESC LIMIT @limit';
  params.limit = opts.limit ?? 100;
  return openDb().prepare(sql).all(params) as IncidentRow[];
}

export function getIncidentById(id: number): IncidentRow | undefined {
  return openDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
}

export function incidentStats(): { total: number; critical: number; warning: number } {
  const db = openDb();
  const total    = (db.prepare('SELECT COUNT(*) as n FROM incidents').get()                              as { n: number }).n;
  const critical = (db.prepare("SELECT COUNT(*) as n FROM incidents WHERE severity = 'critical'").get() as { n: number }).n;
  const warning  = (db.prepare("SELECT COUNT(*) as n FROM incidents WHERE severity = 'warning'").get()  as { n: number }).n;
  return { total, critical, warning };
}
