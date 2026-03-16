import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),

  // AI (DeepSeek API — OpenAI-compatible)
  ai: {
    baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.AI_API_KEY || '',
    routineModel: process.env.AI_ROUTINE_MODEL || 'deepseek-chat',        // DeepSeek V3 — fast
    incidentModel: process.env.AI_INCIDENT_MODEL || 'deepseek-reasoner',   // DeepSeek R1 — reasoning
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '2048', 10),
  },

  // Telegram Bot
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // Kubernetes
  kube: {
    // When running in-cluster, these are auto-detected
    namespaces: (process.env.WATCH_NAMESPACES || 'default,monitoring').split(','),
    inCluster: process.env.KUBE_IN_CLUSTER !== 'false',
  },

  // Monitoring intervals (cron expressions)
  schedules: {
    pods: process.env.SCHEDULE_PODS || '*/2 * * * *',       // every 2 min
    nodes: process.env.SCHEDULE_NODES || '*/5 * * * *',     // every 5 min
    certs: process.env.SCHEDULE_CERTS || '0 */6 * * *',     // every 6 hours
    dailyReport: process.env.SCHEDULE_DAILY_REPORT || '0 9 * * *',  // daily at 9 AM SGT
    security: process.env.SCHEDULE_SECURITY || '*/3 * * * *',       // every 3 min
    load: process.env.SCHEDULE_LOAD || '*/2 * * * *',               // every 2 min
  },

  // Microsoft Teams Bot
  teams: {
    appId: process.env.TEAMS_APP_ID || '',
    appPassword: process.env.TEAMS_APP_PASSWORD || '',
    tenantId: process.env.TEAMS_TENANT_ID || '',
    enabled: !!process.env.TEAMS_APP_ID,
  },

  // Jira
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || 'https://your-org.atlassian.net',
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || 'OPS',
  },

  // Vision AI (for screenshot/image analysis — Google Gemini free tier)
  vision: {
    baseUrl: process.env.VISION_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.VISION_API_KEY || '',
    model: process.env.VISION_MODEL || 'gemini-2.0-flash',
    enabled: !!process.env.VISION_API_KEY,
  },

  // Production URLs for QA smoke tests — configure via PRODUCTION_URLS env var (JSON array)
  // or set this list directly for your environment.
  // expect: expected HTTP status (default 200). Services that require auth or have no root page
  // should set the expected status code they actually return when healthy (e.g., 302, 403, 404).
  // Example:
  //   { name: 'My API', url: 'https://api.example.com/health', expect: 200 },
  //   { name: 'My Frontend', url: 'https://app.example.com', expect: 200 },
  productionUrls: JSON.parse(process.env.PRODUCTION_URLS || '[]'),

  // Email — SMTP (any provider) or AWS SES fallback
  // If SMTP_HOST is set, SMTP is used. Otherwise falls back to AWS SES.
  email: {
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      enabled: !!process.env.SMTP_HOST,
    },
  },

  // Loki (log aggregation)
  loki: {
    baseUrl: process.env.LOKI_URL || 'http://loki.monitoring.svc.cluster.local:3100',
  },

  // Bitbucket (CI/CD pipeline triggers)
  bitbucket: {
    user: process.env.BB_USER || '',
    token: process.env.BB_TOKEN || '',
    enabled: !!process.env.BB_TOKEN,
  },

  // Database (read-only access via bluey_readonly user)
  database: {
    username: process.env.DB_READONLY_USER || 'bluey_readonly',
    password: process.env.DB_READONLY_PASSWORD || '',
    enabled: !!process.env.DB_READONLY_PASSWORD,
  },

  // Grafana (admin API for password resets)
  grafana: {
    internalUrl: process.env.GRAFANA_INTERNAL_URL || 'http://grafana.monitoring.svc.cluster.local:3000',
    externalUrl: process.env.GRAFANA_EXTERNAL_URL || '',
    adminUser: process.env.GRAFANA_ADMIN_USER || 'admin',
    adminPassword: process.env.GRAFANA_ADMIN_PASSWORD || '',
    enabled: !!process.env.GRAFANA_ADMIN_PASSWORD,
  },

  // WAF Security
  waf: {
    webAclName: process.env.WAF_WEB_ACL_NAME || 'my-production-waf',
    scope: (process.env.WAF_SCOPE || 'REGIONAL') as 'REGIONAL' | 'CLOUDFRONT',
    region: process.env.WAF_REGION || 'us-east-1',
    ipSetName: process.env.WAF_IP_SET_NAME || 'blocked-ips',
    autoBlockDurationMinutes: parseInt(process.env.WAF_AUTO_BLOCK_DURATION || '1440', 10), // 24h default
    enabled: process.env.WAF_ENABLED !== 'false', // enabled by default
  },

  // Security monitoring
  security: {
    // Thresholds for threat detection
    blockedRequestSpikeThreshold: parseInt(process.env.SECURITY_BLOCKED_SPIKE || '100', 10), // blocked reqs in 5min
    authFailureThreshold: parseInt(process.env.SECURITY_AUTH_FAIL_THRESHOLD || '20', 10), // auth failures in 5min
    rateLimitThreshold: parseInt(process.env.SECURITY_RATE_LIMIT || '500', 10), // reqs/min from single IP
    autoBlockEnabled: process.env.SECURITY_AUTO_BLOCK !== 'false', // auto-block critical threats
    scanInterval: process.env.SCHEDULE_SECURITY || '*/3 * * * *', // every 3 min
  },

  // Load monitoring & auto-scaling
  load: {
    scanInterval: process.env.SCHEDULE_LOAD || '*/2 * * * *', // every 2 min
    enabled: process.env.LOAD_MONITOR !== 'false',
  },

  // RBAC — Role-Based Access Control
  // Who can use BLUE.Y and at what level.
  // Set RBAC_CONFIG env var to a JSON string matching RBACConfig interface,
  // or configure per-user via values.yaml in the Helm chart.
  rbac: {
    // Fallback: if RBAC_CONFIG env is not set, TELEGRAM_ADMIN_ID is treated as the sole admin.
    telegramAdminId: process.env.TELEGRAM_ADMIN_ID || process.env.TELEGRAM_CHAT_ID || '',
    // Full RBAC config JSON — overrides individual IDs above when present.
    configJson: process.env.RBAC_CONFIG || '',
  },

  // Slack (Socket Mode — no public URL needed)
  slack: {
    appToken: process.env.SLACK_APP_TOKEN || '',    // xapp-... (Socket Mode)
    botToken: process.env.SLACK_BOT_TOKEN || '',    // xoxb-...
    channelId: process.env.SLACK_CHANNEL_ID || '',
    enabled: !!process.env.SLACK_BOT_TOKEN,
  },

  // WhatsApp (via Twilio)
  whatsapp: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_WHATSAPP_FROM || '',  // e.g. whatsapp:+14155238886
    enabled: !!process.env.TWILIO_ACCOUNT_SID,
  },

  // Admin dashboard (premium — src/admin/)
  admin: {
    enabled:         process.env.ADMIN_ENABLED === 'true',
    jwtSecret:       process.env.ADMIN_JWT_SECRET || '',
    host:            process.env.ADMIN_HOST || '',          // e.g. https://admin.example.com
    sessionTtlHours: parseInt(process.env.ADMIN_SESSION_TTL_HOURS || '8', 10),
    dbPath:          process.env.ADMIN_DB_PATH || '/data/blue-y-incidents.sqlite',
    // Bootstrap SuperAdmin (BLY-49): auto-create on first install via values.yaml env vars
    superAdmin: {
      telegramId: process.env.ADMIN_SUPERADMIN_TELEGRAM_ID || process.env.TELEGRAM_ADMIN_ID || '',
      name:       process.env.ADMIN_SUPERADMIN_NAME || 'SuperAdmin',
    },
    // Microsoft OIDC SSO (BLY-53) — Azure AD single-tenant
    microsoft: {
      tenantId:     process.env.MICROSOFT_TENANT_ID     || '',
      clientId:     process.env.MICROSOFT_CLIENT_ID     || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
      enabled:      !!(process.env.MICROSOFT_TENANT_ID && process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    },
    // Google OAuth2 SSO (BLY-54) — Google Workspace
    google: {
      clientId:     process.env.GOOGLE_CLIENT_ID     || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled:      !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
  },

  // Safety
  safety: {
    maxActionsPerHour: parseInt(process.env.MAX_ACTIONS_PER_HOUR || '5', 10),
    auditLogMaxEntries: 1000,
    // Commands BLUE.Y is NEVER allowed to run
    blockedCommands: [
      'kubectl delete pvc',
      'kubectl delete namespace',
      'kubectl delete node',
      'kubectl drain',
      'kubectl cordon',
    ],
  },
};
