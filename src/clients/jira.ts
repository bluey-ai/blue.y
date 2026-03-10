import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface JiraTicket {
  key: string;
  url: string;
}

export interface JiraIssueInfo {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  priority: string;
  type: string;
  created: string;
  updated: string;
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

  /**
   * Search issues using JQL.
   */
  async searchIssues(jql: string, maxResults = 20): Promise<JiraIssueInfo[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: {
            jql,
            maxResults,
            fields: 'key,summary,status,assignee,priority,issuetype,created,updated',
          },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );

      return (response.data.issues || []).map((issue: Record<string, unknown>) => {
        const fields = issue.fields as Record<string, unknown>;
        const status = fields.status as Record<string, unknown> || {};
        const assignee = fields.assignee as Record<string, unknown> || {};
        const priority = fields.priority as Record<string, unknown> || {};
        const issuetype = fields.issuetype as Record<string, unknown> || {};
        return {
          key: String(issue.key || ''),
          summary: String(fields.summary || ''),
          status: String(status.name || 'Unknown'),
          assignee: String(assignee.displayName || 'Unassigned'),
          priority: String(priority.name || ''),
          type: String(issuetype.name || ''),
          created: String(fields.created || ''),
          updated: String(fields.updated || ''),
          url: `${this.baseUrl}/browse/${issue.key}`,
        };
      });
    } catch (err) {
      logger.error(`Jira search failed: ${err}`);
      return [];
    }
  }

  /**
   * Get tickets assigned to a person (fuzzy name match).
   */
  async getTicketsForPerson(name: string, statusFilter?: string): Promise<{ issues: JiraIssueInfo[]; total: number }> {
    try {
      // First find the user by display name
      const userRes = await axios.get(
        `${this.baseUrl}/rest/api/3/user/search`,
        {
          params: { query: name, maxResults: 5 },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );

      const users = userRes.data || [];
      if (users.length === 0) {
        // Fallback: search by display name in JQL
        let jql = `project = ${config.jira.projectKey} AND assignee in membersOf("jira-software-users") AND text ~ "${name.replace(/"/g, '\\"')}"`;
        if (statusFilter) jql += ` AND status = "${statusFilter}"`;
        jql += ' ORDER BY updated DESC';
        const issues = await this.searchIssues(jql, 20);
        return { issues, total: issues.length };
      }

      // Use the first matching user's accountId
      const accountId = users[0].accountId;
      const displayName = users[0].displayName || name;

      let jql = `project = ${config.jira.projectKey} AND assignee = "${accountId}"`;
      if (statusFilter) {
        jql += ` AND status = "${statusFilter}"`;
      } else {
        jql += ' AND status NOT IN (Done, Closed, Resolved)';
      }
      jql += ' ORDER BY priority DESC, updated DESC';

      // Get total count
      const countRes = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: { jql, maxResults: 0, fields: 'key' },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      ).catch(() => ({ data: { total: 0 } }));

      const total = countRes.data.total || 0;
      const issues = await this.searchIssues(jql, 20);

      // Tag the display name onto results
      return { issues, total };
    } catch (err) {
      logger.error(`Jira person search failed: ${err}`);
      return { issues: [], total: 0 };
    }
  }

  /**
   * Get project summary: open tickets by status, assignee breakdown.
   */
  async getProjectSummary(): Promise<{ byStatus: Record<string, number>; byAssignee: Record<string, number>; total: number }> {
    try {
      const jql = `project = ${config.jira.projectKey} AND status NOT IN (Done, Closed, Resolved) ORDER BY updated DESC`;
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search`,
        {
          params: { jql, maxResults: 100, fields: 'status,assignee' },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );

      const issues = response.data.issues || [];
      const byStatus: Record<string, number> = {};
      const byAssignee: Record<string, number> = {};

      for (const issue of issues) {
        const fields = issue.fields || {};
        const status = fields.status?.name || 'Unknown';
        const assignee = fields.assignee?.displayName || 'Unassigned';
        byStatus[status] = (byStatus[status] || 0) + 1;
        byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
      }

      return { byStatus, byAssignee, total: response.data.total || issues.length };
    } catch (err) {
      logger.error(`Jira project summary failed: ${err}`);
      return { byStatus: {}, byAssignee: {}, total: 0 };
    }
  }

  /**
   * Look up a Jira user by name/email. Returns accountId or null.
   */
  async lookupUser(name: string): Promise<{ accountId: string; displayName: string } | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/user/search`,
        {
          params: { query: name, maxResults: 5 },
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );

      const users = response.data || [];
      if (users.length === 0) return null;

      // Prefer exact-ish match on display name
      const nameLower = name.toLowerCase();
      const exact = users.find((u: Record<string, unknown>) =>
        String(u.displayName || '').toLowerCase().includes(nameLower),
      );
      const user = exact || users[0];
      return { accountId: user.accountId, displayName: user.displayName || name };
    } catch (err) {
      logger.error(`Jira user lookup failed for "${name}": ${err}`);
      return null;
    }
  }

  /**
   * Create a ticket from a business report (not an incident — a reported issue or task).
   * Supports assigning to a specific person.
   */
  async createReportedIssue(opts: {
    summary: string;
    description: string;
    reportedBy?: string;
    assigneeAccountId?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
  }): Promise<JiraTicket | null> {
    try {
      // Build ADF description
      const content: AdfNode[] = [];

      if (opts.reportedBy) {
        content.push(
          panel('info',
            paragraph(bold('Reported via BLUE.Y')),
            paragraph(text(`Reported by: ${opts.reportedBy}`)),
            paragraph(text(`Time: ${new Date().toISOString()}`)),
          ),
        );
      }

      // Split description into paragraphs
      const paragraphs = opts.description.split('\n').filter((l) => l.trim());
      for (const p of paragraphs) {
        content.push(paragraph(text(p)));
      }

      const fields: Record<string, unknown> = {
        project: { key: config.jira.projectKey },
        issuetype: { name: opts.issueType || 'Task' },
        summary: opts.summary,
        description: { type: 'doc', version: 1, content },
        labels: [...(opts.labels || []), 'blue-y', 'reported'],
      };

      if (opts.assigneeAccountId) {
        fields.assignee = { accountId: opts.assigneeAccountId };
      }

      if (opts.priority) {
        fields.priority = { name: opts.priority };
      }

      const response = await axios.post(
        `${this.baseUrl}/rest/api/3/issue`,
        { fields },
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

  /**
   * Format ticket list for Telegram.
   */
  static formatTicketsForTelegram(issues: JiraIssueInfo[], title: string, total?: number): string {
    if (issues.length === 0) return `📋 ${title}\n\nNo tickets found.`;

    const priorityIcon = (p: string) => {
      switch (p) {
        case 'Highest': case 'Critical': return '🔴';
        case 'High': return '🟠';
        case 'Medium': return '🟡';
        case 'Low': return '🟢';
        case 'Lowest': return '⚪';
        default: return '⚪';
      }
    };

    const statusIcon = (s: string) => {
      switch (s.toLowerCase()) {
        case 'to do': case 'open': case 'backlog': return '📋';
        case 'in progress': case 'in review': return '🔧';
        case 'done': case 'closed': case 'resolved': return '✅';
        case 'blocked': return '🚫';
        default: return '📌';
      }
    };

    let msg = `📋 <b>${title}</b>`;
    if (total && total > issues.length) msg += ` (showing ${issues.length}/${total})`;
    msg += '\n\n';

    for (const t of issues) {
      msg += `${priorityIcon(t.priority)} <a href="${t.url}">${t.key}</a> ${statusIcon(t.status)} <b>${t.status}</b>\n`;
      msg += `  ${t.summary.substring(0, 80)}${t.summary.length > 80 ? '...' : ''}\n`;
      msg += `  👤 ${t.assignee} | ${t.type}\n\n`;
    }

    return msg;
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
