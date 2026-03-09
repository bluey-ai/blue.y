import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),

  // AWS Bedrock
  bedrock: {
    region: process.env.AWS_REGION || 'ap-southeast-1',
    // Hybrid model strategy: Sonnet for routine, Opus for incidents
    routineModel: process.env.BEDROCK_ROUTINE_MODEL || 'apac.amazon.nova-lite-v1:0',
    incidentModel: process.env.BEDROCK_INCIDENT_MODEL || 'apac.amazon.nova-pro-v1:0',
    maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '2048', 10),
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
