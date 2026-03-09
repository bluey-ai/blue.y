import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface JiraTicket {
  key: string;
  url: string;
}

// ADF (Atlassian Document Format) node helpers
type AdfNode = Record<string, unknown>;

function heading(level: number, text: string): AdfNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraph(...nodes: AdfNode[]): AdfNode {
  return { type: 'paragraph', content: nodes };
}

function text(t: string, marks?: AdfNode[]): AdfNode {
  const node: AdfNode = { type: 'text', text: t };
  if (marks && marks.length) node.marks = marks;
  return node;
}

function bold(t: string): AdfNode {
  return text(t, [{ type: 'strong' }]);
}

function codeBlock(code: string, language?: string): AdfNode {
  return {
    type: 'codeBlock',
    attrs: language ? { language } : {},
    content: [{ type: 'text', text: code }],
  };
}

function panel(panelType: 'info' | 'note' | 'warning' | 'error' | 'success', ...nodes: AdfNode[]): AdfNode {
  return { type: 'panel', attrs: { panelType }, content: nodes };
}

function bulletList(...items: string[]): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [paragraph(text(item))],
    })),
  };
}

function table(headers: string[], rows: string[][]): AdfNode {
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      // Header row
      {
        type: 'tableRow',
        content: headers.map((h) => ({
          type: 'tableHeader',
          content: [paragraph(bold(h))],
        })),
      },
      // Data rows
      ...rows.map((row) => ({
        type: 'tableRow',
        content: row.map((cell) => ({
          type: 'tableCell',
          content: [paragraph(text(cell))],
        })),
      })),
    ],
  };
}

function divider(): AdfNode {
  return { type: 'rule' };
}

export class JiraClient {
  private baseUrl: string;
  private auth: string;

  constructor() {
    this.baseUrl = config.jira.baseUrl;
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
    lokiErrorLogs?: string;
    lokiStats?: string;
    lokiPatterns?: string;
    lokiTrend?: string;
  }): Promise<JiraTicket | null> {
    try {
      const adfContent = this.buildAdfDescription(incident);

      const response = await axios.post(
        `${this.baseUrl}/rest/api/3/issue`,
        {
          fields: {
            project: { key: config.jira.projectKey },
            issuetype: { name: 'Bug' },
            summary: incident.summary,
            description: { type: 'doc', version: 1, content: adfContent },
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

  async findDuplicate(keywords: string): Promise<JiraTicket | null> {
    try {
      // Try keyword match first
      const escaped = keywords.replace(/"/g, '\\"').substring(0, 100);
      const jqlKeyword = `project = ${config.jira.projectKey} AND labels = "blue-y" AND status NOT IN (Done, Closed, Resolved) AND created >= -24h AND summary ~ "${escaped}" ORDER BY created DESC`;
      const res1 = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: { jql: jqlKeyword, maxResults: 1, fields: 'key,summary' },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      ).catch(() => null);

      if (res1 && res1.data?.total > 0) {
        const issue = res1.data.issues[0];
        return { key: issue.key, url: `${this.baseUrl}/browse/${issue.key}` };
      }

      // Fallback: any blue-y ticket from last 2 hours (likely same incident)
      const jqlRecent = `project = ${config.jira.projectKey} AND labels = "blue-y" AND labels = "auto-created" AND status NOT IN (Done, Closed, Resolved) AND created >= -2h ORDER BY created DESC`;
      const res2 = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: { jql: jqlRecent, maxResults: 1, fields: 'key,summary' },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      ).catch(() => null);

      if (res2 && res2.data?.total > 0) {
        const issue = res2.data.issues[0];
        logger.info(`[Jira] Dedup fallback: found recent ticket ${issue.key}`);
        return { key: issue.key, url: `${this.baseUrl}/browse/${issue.key}` };
      }

      return null;
    } catch (err) {
      logger.warn(`Jira duplicate search failed: ${err}`);
      return null;
    }
  }

  async addComment(ticketKey: string, comment: string): Promise<boolean> {
    try {
      // Build structured ADF comment instead of plain text
      const sections = comment.split('\n\n');
      const content: AdfNode[] = sections.map((section) => {
        if (section.startsWith('[BLUE.Y]')) {
          return panel('info', paragraph(text(section)));
        }
        return paragraph(text(section));
      });

      await axios.post(
        `${this.baseUrl}/rest/api/3/issue/${ticketKey}/comment`,
        { body: { type: 'doc', version: 1, content } },
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

  private buildAdfDescription(incident: {
    pod?: string;
    namespace?: string;
    status?: string;
    analysis?: string;
    logs?: string;
    events?: string;
    description?: string;
    lokiErrorLogs?: string;
    lokiStats?: string;
    lokiPatterns?: string;
    lokiTrend?: string;
  }): AdfNode[] {
    const content: AdfNode[] = [];

    // Header panel
    content.push(
      panel('info',
        paragraph(bold('Auto-created by BLUE.Y Incident Monitor')),
        paragraph(text(`Cluster: blo-cluster | Region: ap-southeast-1 | Time: ${new Date().toISOString()}`)),
      ),
    );

    // Environment info table
    if (incident.pod || incident.namespace || incident.status) {
      content.push(heading(2, 'Environment'));
      const rows: string[][] = [];
      if (incident.pod) rows.push(['Pod', `${incident.namespace || 'prod'}/${incident.pod}`]);
      if (incident.namespace) rows.push(['Namespace', incident.namespace]);
      if (incident.status) rows.push(['Status', incident.status]);
      rows.push(['Cluster', 'blo-cluster']);
      rows.push(['Region', 'ap-southeast-1']);
      content.push(table(['Field', 'Value'], rows));
    }

    // AI Analysis (most important for developers)
    if (incident.analysis) {
      content.push(divider());
      content.push(heading(2, 'AI Diagnosis'));
      // Strip HTML tags from analysis
      const cleanAnalysis = incident.analysis.replace(/<[^>]+>/g, '');
      content.push(panel('note', paragraph(text(cleanAnalysis))));
    }

    // Description (user's original report or pod description)
    if (incident.description) {
      content.push(divider());
      content.push(heading(2, 'Details'));
      // Strip HTML and keep plain text
      const cleanDesc = incident.description.replace(/<[^>]+>/g, '');
      content.push(paragraph(text(cleanDesc)));
    }

    // Recent Logs
    if (incident.logs && incident.logs.trim()) {
      content.push(divider());
      content.push(heading(2, 'Recent Logs'));
      content.push(codeBlock(incident.logs.substring(0, 3000), 'text'));
    }

    // Events
    if (incident.events && incident.events.trim() && incident.events !== 'No recent events found.') {
      content.push(heading(3, 'Kubernetes Events'));
      content.push(codeBlock(incident.events.substring(0, 2000), 'text'));
    }

    // Loki Log Analysis
    if (incident.lokiStats || incident.lokiPatterns || incident.lokiErrorLogs) {
      content.push(divider());
      content.push(heading(2, 'Log Analysis (Loki)'));

      if (incident.lokiStats) {
        content.push(panel(incident.lokiTrend === 'increasing' ? 'warning' : 'info',
          paragraph(text(incident.lokiStats)),
        ));
      }

      if (incident.lokiPatterns) {
        content.push(heading(3, 'Top Error Patterns'));
        content.push(codeBlock(incident.lokiPatterns, 'text'));
      }

      if (incident.lokiErrorLogs) {
        content.push(heading(3, 'Recent Error Logs'));
        content.push(codeBlock(incident.lokiErrorLogs.substring(0, 3000), 'text'));
      }
    }

    // Reproduction steps for developers
    content.push(divider());
    content.push(heading(2, 'For Developers'));
    content.push(paragraph(text('Quick commands to investigate:')));
    const cmds = [];
    if (incident.pod && incident.namespace) {
      cmds.push(`kubectl describe pod ${incident.pod} -n ${incident.namespace}`);
      cmds.push(`kubectl logs ${incident.pod} -n ${incident.namespace} --tail=100`);
      cmds.push(`kubectl get events -n ${incident.namespace} --field-selector involvedObject.name=${incident.pod}`);
    }
    cmds.push('kubectl get pods -A | grep -v Running');
    content.push(codeBlock(cmds.join('\n'), 'bash'));

    return content;
  }
}
