import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface DatabaseInfo {
  name: string;
  host: string;
  port: number;
  databases: string[];
  description: string;
}

export interface QueryResult {
  source: string;
  database: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  error?: string;
}

// Blocklist — never allow these even if somehow generated
const BLOCKED_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE)\b/i,
  /\b(INTO\s+OUTFILE|LOAD\s+DATA|SET\s+GLOBAL)\b/i,
  /\b(CALL|EXECUTE|PREPARE)\b/i,
  /;\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/i, // multi-statement injection
];

const MAX_ROWS = 50;
const QUERY_TIMEOUT_MS = 10000;

// Database registry — all accessible databases
export const DATABASE_REGISTRY: DatabaseInfo[] = [
  {
    name: 'hubsprod',
    host: 'hubsprod.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com',
    port: 3306,
    databases: ['jeecg-boot', 'dwd'],
    description: 'Main backend DB: system tables (jeecg-boot) + business data (dwd: BAS, DD, SFDR, PwC, funds, portfolios)',
  },
  {
    name: 'bo-prod-sg',
    host: 'bo-prod-sg.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com',
    port: 3306,
    databases: ['blo_user'],
    description: 'User Management: members, companies, roles, permissions, login history',
  },
  {
    name: 'blueonion',
    host: 'blueonion.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com',
    port: 3306,
    databases: ['prod_blueonion', 'blo_user', 'blueonion'],
    description: 'WordPress + legacy data',
  },
  {
    name: 'faceset-prod',
    host: 'faceset-prod.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com',
    port: 3306,
    databases: ['dwd', 'factset', 'equity', 'edw'],
    description: 'Market data: FactSet feeds, equity, EDW',
  },
  {
    name: 'data-transfer',
    host: 'data-transfer.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com',
    port: 3306,
    databases: ['ods', 'hive', 'irs'],
    description: 'ETL staging: ODS, Hive metastore, IRS data',
  },
  {
    name: 'doris',
    host: 'doris-prod-fe-service.doris.svc.cluster.local',
    port: 9030,
    databases: ['dwd'],
    description: 'Doris analytics: 151 tables, fund performance, ESG scores, screening',
  },
];

export class DatabaseClient {
  private pools: Map<string, mysql.Pool> = new Map();

  constructor() {
    // Pools are created lazily on first query
  }

  private getPoolKey(dbInfo: DatabaseInfo, database: string): string {
    return `${dbInfo.name}:${database}`;
  }

  private getPool(dbInfo: DatabaseInfo, database: string): mysql.Pool {
    const key = this.getPoolKey(dbInfo, database);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = mysql.createPool({
        host: dbInfo.host,
        port: dbInfo.port,
        user: config.database.username,
        password: config.database.password,
        database,
        connectionLimit: 2,
        connectTimeout: 5000,
        enableKeepAlive: false,
        waitForConnections: true,
        queueLimit: 5,
      });
      this.pools.set(key, pool);
      logger.info(`Database pool created: ${key}`);
    }
    return pool;
  }

  /**
   * Find the right database instance + schema for a query target.
   * Accepts: "hubsprod.dwd", "bo-prod-sg.blo_user", "doris.dwd", just "members", etc.
   */
  resolveTarget(target: string): { dbInfo: DatabaseInfo; database: string } | null {
    // Exact match: "hubsprod.dwd"
    if (target.includes('.')) {
      const [instanceName, dbName] = target.split('.', 2);
      const dbInfo = DATABASE_REGISTRY.find((d) => d.name === instanceName);
      if (dbInfo && dbInfo.databases.includes(dbName)) {
        return { dbInfo, database: dbName };
      }
    }

    // Match by database name alone
    for (const dbInfo of DATABASE_REGISTRY) {
      if (dbInfo.databases.includes(target)) {
        return { dbInfo, database: target };
      }
    }

    // Match by instance name (use first database)
    const dbInfo = DATABASE_REGISTRY.find((d) => d.name === target);
    if (dbInfo) {
      return { dbInfo, database: dbInfo.databases[0] };
    }

    return null;
  }

  /**
   * Validate a SQL query — must be SELECT only.
   */
  validateQuery(sql: string): { valid: boolean; reason?: string } {
    const trimmed = sql.trim().replace(/^\/\*.*?\*\//gs, '').trim();

    // Must start with SELECT or SHOW or DESCRIBE
    if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(trimmed)) {
      return { valid: false, reason: 'Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed.' };
    }

    // Check blocklist
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { valid: false, reason: `Blocked: query contains disallowed operation.` };
      }
    }

    // No semicolons (prevent multi-statement)
    if (trimmed.replace(/;$/, '').includes(';')) {
      return { valid: false, reason: 'Multi-statement queries are not allowed.' };
    }

    return { valid: true };
  }

  /**
   * Execute a read-only SQL query against a specific database.
   */
  async query(instanceName: string, database: string, sql: string): Promise<QueryResult> {
    const validation = this.validateQuery(sql);
    if (!validation.valid) {
      return {
        source: instanceName,
        database,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        error: validation.reason,
      };
    }

    const dbInfo = DATABASE_REGISTRY.find((d) => d.name === instanceName);
    if (!dbInfo) {
      return {
        source: instanceName,
        database,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        error: `Unknown database instance: ${instanceName}`,
      };
    }

    if (!dbInfo.databases.includes(database)) {
      return {
        source: instanceName,
        database,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        error: `Database '${database}' not accessible on ${instanceName}. Available: ${dbInfo.databases.join(', ')}`,
      };
    }

    // Add LIMIT if not present
    let safeSql = sql.trim().replace(/;$/, '');
    if (!/\bLIMIT\b/i.test(safeSql)) {
      safeSql += ` LIMIT ${MAX_ROWS}`;
    }

    const pool = this.getPool(dbInfo, database);

    try {
      const connection = await pool.getConnection();
      try {
        // Set session to read-only as extra safety
        await connection.query('SET SESSION TRANSACTION READ ONLY');
        const [rows] = await connection.query({ sql: safeSql, timeout: QUERY_TIMEOUT_MS });

        const resultRows = rows as Record<string, unknown>[];
        const columns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [];
        const truncated = resultRows.length >= MAX_ROWS;

        return {
          source: instanceName,
          database,
          columns,
          rows: resultRows.slice(0, MAX_ROWS),
          rowCount: resultRows.length,
          truncated,
        };
      } finally {
        connection.release();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`DB query failed [${instanceName}.${database}]: ${msg}`);
      return {
        source: instanceName,
        database,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        error: msg.substring(0, 500),
      };
    }
  }

  /**
   * List tables in a database.
   */
  async listTables(instanceName: string, database: string): Promise<string[]> {
    const result = await this.query(instanceName, database, 'SHOW TABLES');
    if (result.error) return [];
    return result.rows.map((r) => Object.values(r)[0] as string);
  }

  /**
   * Describe a table.
   */
  async describeTable(instanceName: string, database: string, table: string): Promise<QueryResult> {
    return this.query(instanceName, database, `DESCRIBE \`${table.replace(/`/g, '')}\``);
  }

  /**
   * Format query results for Telegram (HTML).
   */
  formatForTelegram(result: QueryResult): string {
    if (result.error) {
      return `❌ <b>Error</b> [${result.source}.${result.database}]\n<code>${result.error}</code>`;
    }

    if (result.rows.length === 0) {
      return `ℹ️ No results found on <b>${result.source}.${result.database}</b>`;
    }

    let output = `✅ <b>${result.source}.${result.database}</b> — ${result.rowCount} row${result.rowCount > 1 ? 's' : ''}${result.truncated ? ' (truncated)' : ''}\n\n`;

    // For small result sets, use a readable format
    if (result.rows.length <= 5 && result.columns.length <= 8) {
      for (const row of result.rows) {
        for (const col of result.columns) {
          const val = row[col] === null ? '<i>NULL</i>' : String(row[col]);
          output += `<b>${col}:</b> ${val}\n`;
        }
        output += '\n';
      }
    } else {
      // Table format for larger result sets
      output += '<pre>';
      // Header
      const colWidths = result.columns.map((c) => Math.min(c.length, 20));
      result.rows.forEach((row) => {
        result.columns.forEach((col, i) => {
          const len = String(row[col] ?? '').length;
          colWidths[i] = Math.min(Math.max(colWidths[i], len), 20);
        });
      });

      output += result.columns.map((c, i) => c.substring(0, colWidths[i]).padEnd(colWidths[i])).join(' | ') + '\n';
      output += colWidths.map((w) => '-'.repeat(w)).join('-+-') + '\n';

      for (const row of result.rows.slice(0, 20)) {
        output += result.columns.map((col, i) => {
          const val = String(row[col] ?? '').substring(0, colWidths[i]);
          return val.padEnd(colWidths[i]);
        }).join(' | ') + '\n';
      }
      output += '</pre>';

      if (result.rows.length > 20) {
        output += `\n<i>... and ${result.rows.length - 20} more rows</i>`;
      }
    }

    // Truncate for Telegram's 4096 char limit
    if (output.length > 3900) {
      output = output.substring(0, 3900) + '\n\n<i>... output truncated</i>';
    }

    return output;
  }

  /**
   * Get a summary of all available databases for display.
   */
  getRegistrySummary(): string {
    return DATABASE_REGISTRY.map((db) =>
      `<b>${db.name}</b> — ${db.description}\n  Databases: ${db.databases.join(', ')}`,
    ).join('\n\n');
  }

  async destroy(): Promise<void> {
    for (const [key, pool] of this.pools) {
      try {
        await pool.end();
        logger.info(`Database pool closed: ${key}`);
      } catch (err) {
        logger.error(`Failed to close pool ${key}:`, err);
      }
    }
    this.pools.clear();
  }
}
