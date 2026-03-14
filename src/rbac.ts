/**
 * RBAC — Role-Based Access Control
 *
 * Three roles:
 *   admin    — DevOps/Infra. Full access. All alerts.
 *   operator — On-call/SRE. Actions (no WAF/security/infra). Crit+high alerts.
 *   user     — Non-ops staff. Self-service only. No automatic alerts.
 *
 * Identity is platform-specific (Telegram user ID, Slack user ID, phone number, etc.).
 * Config is loaded from values.yaml → env var RBAC_CONFIG → config.rbac.
 *

 */

export type Role = 'admin' | 'operator' | 'user';
export type Platform = 'telegram' | 'slack' | 'teams' | 'whatsapp';

export interface CallerIdentity {
  platform: Platform;
  id: string;          // platform-native unique ID
  displayName: string; // best-effort name from platform
  rawMessage: string;  // original message text
}

export interface UserConfig {
  platform: Platform;
  id: string;          // platform user ID (phone number for WhatsApp)
  name: string;
  awsUsername?: string; // for /reset password command
  awsAccount?: string;  // AWS profile (defaults to primary)
}

export interface RBACConfig {
  admins: UserConfig[];
  operators: UserConfig[];
  users: UserConfig[];
}

// Commands and the minimum role required to run them.
// 'admin' = admin only, 'operator' = admin+operator, 'user' = all roles
const COMMAND_ROLES: Record<string, Role> = {
  // User-accessible (all roles)
  '/status':           'user',
  '/help':             'user',
  '/ping':             'user',
  '/incidents':        'user',
  '/reset':            'user',  // /reset password

  // Operator + Admin
  '/logs':             'operator',
  '/logsearch':        'operator',
  '/describe':         'operator',
  '/events':           'operator',
  '/nodes':            'operator',
  '/hpa':              'operator',
  '/deployments':      'operator',
  '/deps':             'operator',
  '/resources':        'operator',
  '/load':             'operator',
  '/performance':      'operator',
  '/perf':             'operator',
  '/doris':            'operator',
  '/check':            'operator',
  '/smoketest':        'operator',
  '/smoke':            'operator',
  '/rollout':          'operator',
  '/restart':          'operator',
  '/scale':            'operator',
  '/jira':             'operator',
  '/report-issue':     'operator',
  '/tickets':          'operator',
  '/loki':             'operator',
  '/cronjobs':         'operator',
  '/efficiency':       'operator',
  '/restarts':         'operator',
  '/yes':              'operator',
  '/no':               'operator',
  '/cheatsheet':       'operator',

  // Admin only
  '/waf':              'admin',
  '/security':         'admin',
  '/threats':          'admin',
  '/block':            'admin',
  '/unblock':          'admin',
  '/blocked':          'admin',
  '/scan':             'admin',
  '/securityscan':     'admin',
  '/email':            'admin',
  '/report':           'admin',
  '/sleep':            'admin',
  '/wake':             'admin',
  '/build':            'admin',
  '/pipelines':        'admin',
  '/builds':           'admin',
  '/rds':              'admin',
  '/jobs':             'admin',
  '/glue':             'admin',
  '/costs':            'admin',
  '/backups':          'admin',
  '/backend':          'admin',
  '/db':               'admin',
  '/databases':        'admin',
  '/tables':           'admin',
  '/query':            'admin',
  '/dorisbackup':      'admin',
  '/diagnose':         'admin',
};

const ROLE_WEIGHT: Record<Role, number> = { admin: 3, operator: 2, user: 1 };

export class RBAC {
  constructor(private cfg: RBACConfig) {}

  /** Returns the role for a caller, or null if not registered. */
  getRole(platform: Platform, id: string): Role | null {
    const normalizedId = platform === 'whatsapp' ? normalizePhone(id) : id;
    if (this.cfg.admins.some((u) => u.platform === platform && u.id === normalizedId)) return 'admin';
    if (this.cfg.operators.some((u) => u.platform === platform && u.id === normalizedId)) return 'operator';
    if (this.cfg.users.some((u) => u.platform === platform && u.id === normalizedId)) return 'user';
    return null;
  }

  /** Returns the full user config for a caller. */
  getUser(platform: Platform, id: string): UserConfig | null {
    const normalizedId = platform === 'whatsapp' ? normalizePhone(id) : id;
    const all = [...this.cfg.admins, ...this.cfg.operators, ...this.cfg.users];
    return all.find((u) => u.platform === platform && u.id === normalizedId) ?? null;
  }

  /**
   * Returns true if `role` is allowed to run `command`.
   * Command is the first token of the message (e.g. '/restart').
   */
  isAllowed(role: Role, command: string): boolean {
    const normalizedCmd = command.split(' ')[0].toLowerCase();
    const required = COMMAND_ROLES[normalizedCmd];
    if (!required) return role === 'admin'; // unknown commands: admin only
    return ROLE_WEIGHT[role] >= ROLE_WEIGHT[required];
  }

  /** Human-readable "not allowed" message based on what the user tried to do. */
  deniedMessage(role: Role, command: string): string {
    const normalizedCmd = command.split(' ')[0].toLowerCase();
    const required = COMMAND_ROLES[normalizedCmd] ?? 'admin';

    if (role === 'user') {
      return `You don't have access to that command.\n\nYou can use: /status, /ping, /incidents, /reset password\nType /help to see your options.`;
    }
    if (role === 'operator' && required === 'admin') {
      return `⛔ <b>Admin only</b>\n<code>${normalizedCmd}</code> requires admin access.`;
    }
    return `⛔ Not authorized for <code>${normalizedCmd}</code>.`;
  }

  /** Message for unknown callers. */
  static unknownCallerMessage(): string {
    return 'You are not registered with BLUE.Y. Contact your DevOps team to get access.';
  }
}

/** Normalize WhatsApp phone numbers to E.164 format. */
function normalizePhone(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/** Load RBAC config from env var JSON or use defaults. */
export function loadRBACConfig(fallbackAdminTelegramId?: string): RBACConfig {
  if (process.env.RBAC_CONFIG) {
    try {
      return JSON.parse(process.env.RBAC_CONFIG) as RBACConfig;
    } catch {
      // fall through to defaults
    }
  }
  return {
    admins: fallbackAdminTelegramId
      ? [{ platform: 'telegram', id: fallbackAdminTelegramId, name: 'Admin' }]
      : [],
    operators: [],
    users: [],
  };
}
