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
  },

  // Jira
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || 'https://blueonion.atlassian.net',
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || 'HUBS',
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
