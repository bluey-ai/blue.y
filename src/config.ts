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
    namespaces: (process.env.WATCH_NAMESPACES || 'prod,doris,monitoring,wordpress').split(','),
    inCluster: process.env.KUBE_IN_CLUSTER !== 'false',
  },

  // Monitoring intervals (cron expressions)
  schedules: {
    pods: process.env.SCHEDULE_PODS || '*/2 * * * *',       // every 2 min
    nodes: process.env.SCHEDULE_NODES || '*/5 * * * *',     // every 5 min
    certs: process.env.SCHEDULE_CERTS || '0 */6 * * *',     // every 6 hours
    dailyReport: process.env.SCHEDULE_DAILY_REPORT || '0 9 * * *',  // daily at 9 AM SGT
    security: process.env.SCHEDULE_SECURITY || '*/3 * * * *',       // every 3 min
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
    baseUrl: process.env.JIRA_BASE_URL || 'https://blueonion.atlassian.net',
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || 'HUBS',
  },

  // Vision AI (for screenshot/image analysis — Google Gemini free tier)
  vision: {
    baseUrl: process.env.VISION_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.VISION_API_KEY || '',
    model: process.env.VISION_MODEL || 'gemini-2.0-flash',
    enabled: !!process.env.VISION_API_KEY,
  },

  // Production URLs for QA smoke tests
  // expect: expected HTTP status (default 200). Services that require auth or have no root page
  // should set the expected status code they actually return when healthy (e.g., 302, 403, 404).
  productionUrls: [
    { name: 'Backend API', url: 'https://api-hubs.blueonion.today', expect: 200 },
    { name: 'Frontend', url: 'https://hubs.blueonion.today', expect: 200 },
    { name: 'User Mgmt API', url: 'https://api-users.blueonion.today', expect: 404 },   // NestJS returns 404 at root (no route)
    { name: 'User Mgmt UI', url: 'https://users.blueonion.today', expect: 200 },
    { name: 'PDF Service', url: 'https://hubspdf.blueonion.today', expect: 404 },        // No root handler, 404 = server is running
    { name: 'BLUE.AI', url: 'https://ai.blueonion.today', expect: 404 },                 // No root handler, 404 = server is running
    { name: 'Grafana', url: 'https://grafana.blueonion.today/api/health', expect: 200 },   // Grafana health endpoint (bypasses auth)
    { name: 'Status Page', url: 'https://status.blueonion.today', expect: 200 },
    { name: 'WordPress', url: 'https://www.blueonion.today', expect: 200 },
  ],

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
    adminUser: process.env.GRAFANA_ADMIN_USER || 'admin',
    adminPassword: process.env.GRAFANA_ADMIN_PASSWORD || '',
    enabled: !!process.env.GRAFANA_ADMIN_PASSWORD,
  },

  // WAF Security
  waf: {
    webAclName: process.env.WAF_WEB_ACL_NAME || 'bluecomm-production-waf',
    scope: (process.env.WAF_SCOPE || 'REGIONAL') as 'REGIONAL' | 'CLOUDFRONT',
    region: process.env.WAF_REGION || 'ap-southeast-1',
    ipSetName: process.env.WAF_IP_SET_NAME || 'blue-y-blocked-ips',
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
