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

  // Search for recent open tickets to avoid duplicates
  async findDuplicate(keywords: string): Promise<JiraTicket | null> {
    try {
      // Search for open blue-y tickets created in last 24h with similar text
      const jql = `project = ${config.jira.projectKey} AND labels = "blue-y" AND status NOT IN (Done, Closed, Resolved) AND created >= -24h AND summary ~ "${keywords.replace(/"/g, '\\"').substring(0, 100)}" ORDER BY created DESC`;
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: { jql, maxResults: 1, fields: 'key,summary' },
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      if (response.data.total > 0) {
        const issue = response.data.issues[0];
        return { key: issue.key, url: `${this.baseUrl}/browse/${issue.key}` };
      }
      return null;
    } catch (err) {
      logger.warn(`Jira duplicate search failed: ${err}`);
      return null;
    }
  }

  // Add a comment to an existing ticket
  async addComment(ticketKey: string, comment: string): Promise<boolean> {
    try {
      await axios.post(
        `${this.baseUrl}/rest/api/3/issue/${ticketKey}/comment`,
        {
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: comment }],
              },
            ],
          },
        },
        {
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );
      return true;
    } catch (err) {
      logger.error(`Failed to add Jira comment to ${ticketKey}: ${err}`);
      return false;
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
