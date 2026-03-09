import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface JiraTicket {
  key: string;
  url: string;
}

export class JiraClient {
  private baseUrl: string;
  private auth: string;

  constructor() {
    this.baseUrl = config.jira.baseUrl;
    // Basic auth: email:api-token
    this.auth = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
  }

  async createIncidentTicket(incident: {
    summary: string;
    pod?: string;
    namespace?: string;
    status?: string;
    analysis?: string;
    logs?: string;
    events?: string;
    description?: string;
    severity?: string;
  }): Promise<JiraTicket | null> {
    try {
      const description = this.buildDescription(incident);

      const response = await axios.post(
        `${this.baseUrl}/rest/api/3/issue`,
        {
          fields: {
            project: { key: config.jira.projectKey },
            issuetype: { name: 'Bug' },
            summary: incident.summary,
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: description }],
                },
              ],
            },
            labels: ['blue-y', 'incident', 'auto-created'],
            ...(incident.severity === 'critical' ? { priority: { name: 'High' } } : {}),
          },
        },
        {
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );

      const key = response.data.key;
      const url = `${this.baseUrl}/browse/${key}`;
      logger.info(`Jira ticket created: ${key}`);
      return { key, url };
    } catch (err) {
      logger.error(`Failed to create Jira ticket: ${err}`);
      return null;
    }
  }

  private buildDescription(incident: {
    pod?: string;
    namespace?: string;
    status?: string;
    analysis?: string;
    logs?: string;
    events?: string;
    description?: string;
  }): string {
    const parts: string[] = [
      '🚨 Auto-created by BLUE.Y Incident Monitor\n',
    ];

    if (incident.pod) parts.push(`Pod: ${incident.namespace}/${incident.pod}`);
    if (incident.status) parts.push(`Status: ${incident.status}`);
    if (incident.analysis) parts.push(`\nAI Analysis:\n${incident.analysis}`);
    if (incident.description) parts.push(`\nPod Details:\n${incident.description}`);
    if (incident.logs) parts.push(`\nRecent Logs (last 30 lines):\n${incident.logs.substring(0, 2000)}`);
    if (incident.events) parts.push(`\nEvents:\n${incident.events}`);

    parts.push(`\nTimestamp: ${new Date().toISOString()}`);
    parts.push('Cluster: blo-cluster | Region: ap-southeast-1');

    return parts.join('\n');
  }
}
