// @premium — BlueOnion internal only.
import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type AdminRole = 'superadmin' | 'admin' | 'viewer';

/** Magic-link / bot users (Telegram, Slack, Teams). Role column added BLY-49. */
export interface AdminUserRow {
  id:          number;
  platform_id: string;   // e.g. Telegram numeric ID or Slack user ID
  platform:    string;   // 'telegram' | 'slack' | 'teams' | 'whatsapp'
  name:        string;
  role:        AdminRole;
  created_at:  string;
}

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
    CREATE TABLE IF NOT EXISTS admin_users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_id TEXT    NOT NULL,
      platform    TEXT    NOT NULL,
      name        TEXT    NOT NULL DEFAULT '',
      role        TEXT    NOT NULL DEFAULT 'admin',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform_id, platform)
    );

    CREATE TABLE IF NOT EXISTS ip_allowlist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cidr       TEXT    NOT NULL UNIQUE,
      label      TEXT    NOT NULL DEFAULT '',
      added_by   TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sso_invites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT    NOT NULL UNIQUE,
      role        TEXT    NOT NULL DEFAULT 'admin',
      invited_by  TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'active',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sso_invites_email  ON sso_invites(email);
    CREATE INDEX IF NOT EXISTS idx_sso_invites_status ON sso_invites(status);
  `);
  // Migration: add joined_at column (safe on existing DBs)
  try { db.exec("ALTER TABLE sso_invites ADD COLUMN joined_at TEXT"); } catch { /* already exists */ }
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

// ── admin_users helpers ───────────────────────────────────────────────────────

/**
 * BLY-49: Bootstrap SuperAdmin on first install.
 * Inserts a superadmin row only when the table is empty and env vars are configured.
 */
export function bootstrapSuperAdmin(): void {
  const { telegramId, name } = config.admin.superAdmin;
  if (!telegramId) return;

  const database = openDb();
  const count = (database.prepare('SELECT COUNT(*) as n FROM admin_users').get() as { n: number }).n;
  if (count > 0) return; // already bootstrapped

  database.prepare(`
    INSERT OR IGNORE INTO admin_users (platform_id, platform, name, role)
    VALUES (?, 'telegram', ?, 'superadmin')
  `).run(telegramId, name);

  logger.info(`[admin] SuperAdmin bootstrapped: telegram:${telegramId} (${name})`);
}

export function getAdminUser(platformId: string, platform: string): AdminUserRow | undefined {
  return openDb()
    .prepare('SELECT * FROM admin_users WHERE platform_id = ? AND platform = ?')
    .get(platformId, platform) as AdminUserRow | undefined;
}

export function listAdminUsers(): AdminUserRow[] {
  return openDb().prepare('SELECT * FROM admin_users ORDER BY created_at ASC').all() as AdminUserRow[];
}

export function upsertAdminUser(platformId: string, platform: string, name: string, role: AdminRole): void {
  openDb().prepare(`
    INSERT INTO admin_users (platform_id, platform, name, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(platform_id, platform) DO UPDATE SET name = excluded.name, role = excluded.role
  `).run(platformId, platform, name, role);
}

export function deleteAdminUser(platformId: string, platform: string): boolean {
  const result = openDb()
    .prepare('DELETE FROM admin_users WHERE platform_id = ? AND platform = ?')
    .run(platformId, platform);
  return result.changes > 0;
}

// ── sso_invites helpers (BLY-50) ─────────────────────────────────────────────

export interface SsoInviteRow {
  id:         number;
  email:      string;
  role:       AdminRole;
  invited_by: string;   // platform_id of the inviting SuperAdmin
  status:     'active' | 'revoked';
  joined_at:  string | null;  // set on first successful SSO login
  created_at: string;
  updated_at: string;
}

export function getSsoInvite(email: string): SsoInviteRow | undefined {
  return openDb()
    .prepare('SELECT * FROM sso_invites WHERE email = ?')
    .get(email.toLowerCase().trim()) as SsoInviteRow | undefined;
}

export function listSsoInvites(): SsoInviteRow[] {
  return openDb().prepare('SELECT * FROM sso_invites ORDER BY created_at ASC').all() as SsoInviteRow[];
}

export function countActiveInvites(): number {
  return (openDb().prepare("SELECT COUNT(*) as n FROM sso_invites WHERE status = 'active'").get() as { n: number }).n;
}

/** Count only users who have actually logged in (joined). Used for seat billing. */
export function countJoinedInvites(): number {
  return (openDb().prepare("SELECT COUNT(*) as n FROM sso_invites WHERE status = 'active' AND joined_at IS NOT NULL").get() as { n: number }).n;
}

/** Mark an invite as joined on first successful SSO login. */
export function markInviteJoined(email: string): void {
  openDb().prepare(
    "UPDATE sso_invites SET joined_at = datetime('now'), updated_at = datetime('now') WHERE email = ? AND joined_at IS NULL"
  ).run(email.toLowerCase().trim());
}

export function createSsoInvite(email: string, role: AdminRole, invitedBy: string): SsoInviteRow {
  const db = openDb();
  db.prepare(`
    INSERT INTO sso_invites (email, role, invited_by, status)
    VALUES (?, ?, ?, 'active')
  `).run(email.toLowerCase().trim(), role, invitedBy);
  return db.prepare('SELECT * FROM sso_invites WHERE email = ?').get(email.toLowerCase().trim()) as SsoInviteRow;
}

export function revokeSsoInvite(email: string): boolean {
  const result = openDb().prepare(`
    UPDATE sso_invites SET status = 'revoked', updated_at = datetime('now') WHERE email = ?
  `).run(email.toLowerCase().trim());
  return result.changes > 0;
}

export function changeSsoInviteRole(email: string, role: AdminRole): boolean {
  const result = openDb().prepare(`
    UPDATE sso_invites SET role = ?, updated_at = datetime('now') WHERE email = ? AND status = 'active'
  `).run(role, email.toLowerCase().trim());
  return result.changes > 0;
}

// ── ip_allowlist helpers (BLY-52/55) ─────────────────────────────────────────

export interface IpAllowlistRow {
  id:         number;
  cidr:       string;
  label:      string;
  added_by:   string;
  created_at: string;
}

export function listAllowlist(): IpAllowlistRow[] {
  return openDb().prepare('SELECT * FROM ip_allowlist ORDER BY created_at ASC').all() as IpAllowlistRow[];
}

export function addToAllowlist(cidr: string, label: string, addedBy: string): void {
  openDb().prepare(`
    INSERT OR IGNORE INTO ip_allowlist (cidr, label, added_by) VALUES (?, ?, ?)
  `).run(cidr, label, addedBy);
}

export function removeFromAllowlist(id: number): boolean {
  const result = openDb().prepare('DELETE FROM ip_allowlist WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── incidents helpers ─────────────────────────────────────────────────────────

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
