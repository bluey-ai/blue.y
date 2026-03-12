import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
  TurnContext,
  ActivityTypes,
  ConversationReference,
  CardFactory,
  MessageFactory,
} from 'botbuilder';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface TeamsAttachment {
  contentType: string;
  contentUrl: string;
  name?: string;
}

export interface TeamsTicket {
  id: string;
  userName: string;
  userMessage: string;
  conversationRef: Partial<ConversationReference>;
  attachments?: TeamsAttachment[];
  imageAnalysis?: string;
  diagnosis?: string;
  suggestedAction?: string;
  status: 'pending' | 'diagnosing' | 'awaiting_approval' | 'in_progress' | 'resolved' | 'escalated';
  createdAt: Date;
}

// Callback type for when a user sends a message via Teams
type OnUserReportCallback = (ticket: TeamsTicket) => Promise<void>;

// Callback type for password reset requests via Teams DM
type OnPasswordResetCallback = (ticketId: string, userName: string, service: string) => Promise<void>;

// Callback type for Jira queries via Teams
type OnJiraQueryCallback = (ticket: TeamsTicket, userName: string) => Promise<void>;

// Per-user conversation history entry
export interface ConversationEntry {
  role: 'user' | 'assistant';
  message: string;
  timestamp: Date;
  ticketId?: string;
  ticketStatus?: TeamsTicket['status'];
}

export class TeamsClient {
  private adapter: CloudAdapter | null = null;
  private onUserReport?: OnUserReportCallback;
  private onPasswordReset?: OnPasswordResetCallback;
  private onJiraQuery?: OnJiraQueryCallback;
  // Store active tickets for cross-channel flow
  private tickets: Map<string, TeamsTicket> = new Map();
  private ticketCounter = 0;
  // Per-user conversation history (keyed by userName)
  private conversationHistory: Map<string, ConversationEntry[]> = new Map();

  constructor() {
    if (!config.teams.enabled) {
      logger.info('[Teams] Not configured — Teams integration disabled');
      return;
    }

    const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
      MicrosoftAppId: config.teams.appId,
      MicrosoftAppPassword: config.teams.appPassword,
      MicrosoftAppTenantId: config.teams.tenantId,
      MicrosoftAppType: 'SingleTenant',
    };

    const botAuth = new ConfigurationBotFrameworkAuthentication(authConfig);
    this.adapter = new CloudAdapter(botAuth);

    // Error handler
    this.adapter.onTurnError = async (context: TurnContext, error: Error) => {
      logger.error('[Teams] Turn error', error);
      await context.sendActivity('Sorry, something went wrong. The ops team has been notified.');
    };

    logger.info('[Teams] Bot adapter initialized');
  }

  setOnUserReport(callback: OnUserReportCallback): void {
    this.onUserReport = callback;
  }

  setOnPasswordReset(callback: OnPasswordResetCallback): void {
    this.onPasswordReset = callback;
  }

  setOnJiraQuery(callback: OnJiraQueryCallback): void {
    this.onJiraQuery = callback;
  }

  getAdapter(): CloudAdapter | null {
    return this.adapter;
  }

  isEnabled(): boolean {
    return this.adapter !== null;
  }

  // Process incoming Teams messages
  async handleMessage(context: TurnContext): Promise<void> {
    if (context.activity.type !== ActivityTypes.Message) return;

    // Strip Teams <at>...</at> mention tags and clean up extra whitespace
    const text = (context.activity.text || '').replace(/<at[^>]*>.*?<\/at>/gi, '').trim();
    const userName = context.activity.from?.name || 'Unknown User';

    if (!text) return;

    // Handle simple commands from Teams users
    const cmd = text.toLowerCase();

    if (cmd === 'help' || cmd === '/help') {
      const helpCard = {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body: [
          {
            type: 'ColumnSet',
            columns: [
              { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '👁️', size: 'extraLarge' }] },
              {
                type: 'Column', width: 'stretch',
                items: [
                  { type: 'TextBlock', text: 'BLUE.Y', weight: 'bolder', size: 'large', color: 'accent' },
                  { type: 'TextBlock', text: 'IT Support & Infrastructure Assistant', spacing: 'none', isSubtle: true, size: 'small' },
                ],
              },
            ],
          },
          { type: 'TextBlock', text: 'Just describe your issue in plain English:', weight: 'bolder', size: 'small', spacing: 'medium', separator: true },
          {
            type: 'Container',
            style: 'emphasis',
            items: [
              { type: 'TextBlock', text: '"The website is slow"', isSubtle: true, size: 'small' },
              { type: 'TextBlock', text: '"PDF service is not working"', isSubtle: true, size: 'small', spacing: 'small' },
              { type: 'TextBlock', text: '"I can\'t log in to the platform"', isSubtle: true, size: 'small', spacing: 'small' },
              { type: 'TextBlock', text: '"Data is not loading on the dashboard"', isSubtle: true, size: 'small', spacing: 'small' },
            ],
          },
          { type: 'TextBlock', text: '⚡ Quick Commands', weight: 'bolder', size: 'small', color: 'accent', spacing: 'medium', separator: true },
          {
            type: 'FactSet',
            facts: [
              { title: 'status', value: 'Cluster health overview' },
              { title: 'smoke test', value: 'Test all production URLs' },
              { title: 'security scan', value: 'OWASP security headers check' },
              { title: 'help', value: 'Show this message' },
            ],
          },
          {
            type: 'Container',
            style: 'accent',
            spacing: 'medium',
            items: [{ type: 'TextBlock', text: '📸 Tip: Attach screenshots — I\'ll analyze them with AI vision!', wrap: true, size: 'small' }],
          },
        ],
      };
      const attachment = CardFactory.adaptiveCard(helpCard);
      await context.sendActivity(MessageFactory.attachment(attachment));
      return;
    }

    if (cmd === 'status' || cmd === '/status' || cmd === 'check status' || cmd === 'health check') {
      await context.sendActivity('Checking cluster health for you...');
      const ticket = this.createTicket(userName, 'status_check', context);
      ticket.status = 'diagnosing';
      if (this.onUserReport) await this.onUserReport(ticket);
      return;
    }

    if (cmd === 'smoketest' || cmd === '/smoketest' || cmd === 'smoke test'
      || cmd.includes('smoke test') || cmd.includes('smoketest')
      || (cmd.includes('smoke') && cmd.includes('test'))) {
      await context.sendActivity('Running smoke tests on all production URLs...');
      const ticket = this.createTicket(userName, 'smoke_test', context);
      ticket.status = 'diagnosing';
      if (this.onUserReport) await this.onUserReport(ticket);
      return;
    }

    if (cmd === 'securityscan' || cmd === '/securityscan' || cmd === 'security scan'
      || cmd.includes('security scan') || cmd.includes('securityscan')
      || (cmd.includes('security') && cmd.includes('scan'))
      || cmd.includes('owasp')) {
      await context.sendActivity('Running security scan on all production URLs...');
      const ticket = this.createTicket(userName, 'security_scan', context);
      ticket.status = 'diagnosing';
      if (this.onUserReport) await this.onUserReport(ticket);
      return;
    }

    // Password reset detection — only in personal (DM) conversations
    const isPersonalChat = context.activity.conversation?.conversationType === 'personal';
    const resetMatch = cmd.match(/(?:reset|forgot|change|update|new)\s+(?:my\s+)?(?:password|pwd|pass|credentials?|login)\s*(?:for|on|of|in)?\s*(.*)/i)
      || cmd.match(/(aws|office\s*365|microsoft\s*365|o365|m365|database|db|rds|grafana)\s+(?:password|pwd|pass|credentials?|login)\s*(?:reset|forgot|change|new)?/i)
      || cmd.match(/(?:i\s+)?(?:forgot|lost|can'?t\s+(?:login|log\s*in|access|remember))\s*(?:to|my|the)?\s*(?:password|pwd|pass|credentials?)?\s*(?:for|on|of|in)?\s*(.*)/i);

    if (resetMatch && isPersonalChat) {
      const serviceRaw = (resetMatch[1] || '').trim().toLowerCase();

      let service = 'unknown';
      if (/aws|console|iam/i.test(serviceRaw) || /aws|console|iam/i.test(cmd)) service = 'aws';
      else if (/office|o365|m365|microsoft|outlook|teams|365/i.test(serviceRaw) || /office|o365|m365|microsoft|outlook|teams|365/i.test(cmd)) service = 'office365';
      else if (/database|db|rds|mysql|postgres/i.test(serviceRaw) || /database|db|rds|mysql/i.test(cmd)) service = 'database';
      else if (/grafana/i.test(serviceRaw) || /grafana/i.test(cmd)) service = 'grafana';

      const serviceLabels: Record<string, string> = {
        aws: 'AWS Console (IAM)',
        office365: 'Microsoft 365 (Office)',
        database: 'Database (RDS)',
        grafana: 'Grafana',
        unknown: 'Unknown',
      };

      if (service === 'unknown') {
        await context.sendActivity(
          `Hi ${userName}! I can help reset your password.\n\n` +
          `Please specify which service:\n` +
          `• **AWS Console** — "reset my password for AWS"\n` +
          `• **Microsoft 365** — "forgot my Office 365 password"\n` +
          `• **Database** — "reset my database password"\n` +
          `• **Grafana** — "forgot my Grafana login"`,
        );
        return;
      }

      // Create ticket to store conversation reference for reply
      const ticket = this.createTicket(userName, `password_reset:${service}`, context);
      ticket.status = 'pending';

      await context.sendActivity(
        `✅ Got it, ${userName}! Your password reset request for **${serviceLabels[service]}** has been sent to the admin for approval.\n\n` +
        `⏳ I'll notify you here once it's approved and processed. This usually takes a few minutes.`,
      );

      logger.info(`[Teams] Password reset request from ${userName} (ticket ${ticket.id}) for ${service}`);

      // Fire callback to notify admin via Telegram
      if (this.onPasswordReset) {
        await this.onPasswordReset(ticket.id, userName, service);
      }
      return;
    }

    // If password reset request but NOT in personal chat, redirect to DM
    if (resetMatch && !isPersonalChat) {
      await context.sendActivity(
        `🔐 For security, password resets must be done via **direct message**.\n\n` +
        `Please DM me directly (click on my name → "Chat") and send your request there.`,
      );
      return;
    }

    // Jira-related queries — route to Jira handler instead of diagnose
    const isJiraQuery = config.jira.apiToken && (
      /\bjira\b/i.test(text) ||
      /\btickets?\b/i.test(text) ||
      /\bissues?\b/i.test(text) ||
      /\b(BAS|HUBS|UM|CRM|EVERCOMM)-\d+/i.test(text) ||
      /\bsprint\b/i.test(text) ||
      /\bbacklog\b/i.test(text) ||
      /\bepic\b/i.test(text) ||
      /\bassigned\b/i.test(text)
    );

    if (isJiraQuery && this.onJiraQuery) {
      await context.sendActivity(`🎫 Querying Jira for you, ${userName}...`);
      const ticket = this.createTicket(userName, text, context);
      ticket.status = 'diagnosing';
      await this.onJiraQuery(ticket, userName);
      return;
    }

    // Everything else = user issue report
    // Record user message in conversation history
    this.addToHistory(userName, 'user', text);

    // Extract image attachments (screenshots, photos)
    const imageAttachments = this.extractImageAttachments(context);
    const hasImages = imageAttachments.length > 0;

    await context.sendActivity(
      `Got it, **${userName}**. I'm looking into: "${text}"` +
      (hasImages ? `\n\nI also see ${imageAttachments.length} image(s) — I'll analyze those too.` : '') +
      '\n\nI\'ll diagnose this and get back to you shortly.',
    );

    const ticket = this.createTicket(userName, text, context);
    if (hasImages) {
      ticket.attachments = imageAttachments;
    }
    logger.info(`[Teams] New ticket ${ticket.id} from ${userName}: ${text}${hasImages ? ` (${imageAttachments.length} images)` : ''}`);

    if (this.onUserReport) {
      await this.onUserReport(ticket);
    }
  }

  // Extract image attachments from a Teams message
  private extractImageAttachments(context: TurnContext): TeamsAttachment[] {
    const attachments: TeamsAttachment[] = [];

    // Check activity.attachments (inline images, file uploads)
    if (context.activity.attachments) {
      for (const att of context.activity.attachments) {
        const ct = att.contentType || '';
        if (ct.startsWith('image/') || ct === 'application/octet-stream') {
          if (att.contentUrl) {
            attachments.push({
              contentType: ct,
              contentUrl: att.contentUrl,
              name: att.name,
            });
          }
        }
      }
    }

    // Check for inline images in HTML content (Teams pastes screenshots as <img> tags)
    const htmlContent = context.activity.text || '';
    const imgMatches = htmlContent.match(/<img[^>]+src="([^"]+)"/gi);
    if (imgMatches) {
      for (const imgTag of imgMatches) {
        const srcMatch = imgTag.match(/src="([^"]+)"/);
        if (srcMatch?.[1] && !attachments.some((a) => a.contentUrl === srcMatch[1])) {
          attachments.push({
            contentType: 'image/png',
            contentUrl: srcMatch[1],
            name: 'inline-screenshot',
          });
        }
      }
    }

    return attachments;
  }

  private createTicket(userName: string, message: string, context: TurnContext): TeamsTicket {
    this.ticketCounter++;
    const id = `T-${Date.now()}-${this.ticketCounter}`;
    const conversationRef = TurnContext.getConversationReference(context.activity);

    const ticket: TeamsTicket = {
      id,
      userName,
      userMessage: message,
      conversationRef,
      status: 'pending',
      createdAt: new Date(),
    };

    this.tickets.set(id, ticket);

    // Cleanup old tickets (keep last 100)
    if (this.tickets.size > 100) {
      const oldest = [...this.tickets.keys()].slice(0, this.tickets.size - 100);
      oldest.forEach((k) => this.tickets.delete(k));
    }

    return ticket;
  }

  // Send a proactive message back to the Teams user
  async replyToTicket(ticketId: string, message: string): Promise<boolean> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !this.adapter) {
      logger.warn(`[Teams] Ticket ${ticketId} not found or adapter not initialized`);
      return false;
    }

    try {
      await this.adapter.continueConversationAsync(
        config.teams.appId,
        ticket.conversationRef,
        async (context: TurnContext) => {
          await context.sendActivity(message);
        },
      );
      return true;
    } catch (err) {
      logger.error(`[Teams] Failed to reply to ticket ${ticketId}`, err);
      return false;
    }
  }

  // Send an Adaptive Card to the Teams user
  async replyWithCard(ticketId: string, card: Record<string, unknown>): Promise<boolean> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !this.adapter) {
      logger.warn(`[Teams] Ticket ${ticketId} not found or adapter not initialized`);
      return false;
    }

    try {
      await this.adapter.continueConversationAsync(
        config.teams.appId,
        ticket.conversationRef,
        async (context: TurnContext) => {
          const attachment = CardFactory.adaptiveCard(card);
          const activity = MessageFactory.attachment(attachment);
          await context.sendActivity(activity);
        },
      );
      return true;
    } catch (err) {
      logger.error(`[Teams] Failed to send card to ticket ${ticketId}`, err);
      return false;
    }
  }

  // Update ticket status and notify the user
  async updateTicket(ticketId: string, status: TeamsTicket['status'], message?: string): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return;

    ticket.status = status;

    if (message) {
      // Send as Adaptive Card for rich formatting
      const card = TeamsCards.statusUpdate(status, message, ticketId);
      const sent = await this.replyWithCard(ticketId, card);
      if (!sent) {
        // Fallback to plain text if card fails
        await this.replyToTicket(ticketId, message);
      }
      // Record status updates in conversation history
      this.addToHistory(ticket.userName, 'assistant', `[${status}] ${message.substring(0, 200)}`, ticketId, status);
    }
  }

  getTicket(ticketId: string): TeamsTicket | undefined {
    return this.tickets.get(ticketId);
  }

  getActiveTickets(): TeamsTicket[] {
    return [...this.tickets.values()].filter((t) =>
      t.status !== 'resolved' && t.status !== 'escalated',
    );
  }

  // --- Conversation history management ---

  addToHistory(userName: string, role: 'user' | 'assistant', message: string, ticketId?: string, ticketStatus?: TeamsTicket['status']): void {
    if (!this.conversationHistory.has(userName)) {
      this.conversationHistory.set(userName, []);
    }
    const history = this.conversationHistory.get(userName)!;
    history.push({ role, message, timestamp: new Date(), ticketId, ticketStatus });

    // Keep last 20 entries per user (10 exchanges)
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }
  }

  getHistory(userName: string): ConversationEntry[] {
    return this.conversationHistory.get(userName) || [];
  }

  // Get recent conversation context as a formatted string for AI
  getConversationContext(userName: string): string {
    const history = this.getHistory(userName);
    if (history.length === 0) return '';

    // Include active tickets for this user
    const activeTickets = [...this.tickets.values()].filter(
      (t) => t.userName === userName && t.status !== 'resolved' && t.status !== 'escalated',
    );

    let context = '=== CONVERSATION HISTORY (this user) ===\n';
    for (const entry of history) {
      const time = entry.timestamp.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });
      const prefix = entry.role === 'user' ? `[${time}] User` : `[${time}] BLUE.Y`;
      const statusTag = entry.ticketStatus ? ` [ticket: ${entry.ticketStatus}]` : '';
      context += `${prefix}${statusTag}: ${entry.message}\n`;
    }

    if (activeTickets.length > 0) {
      context += '\n=== ACTIVE TICKETS FOR THIS USER ===\n';
      for (const t of activeTickets) {
        context += `- ${t.id}: "${t.userMessage}" → status: ${t.status}`;
        if (t.diagnosis) context += ` | diagnosis: ${t.diagnosis.substring(0, 150)}`;
        if (t.suggestedAction) context += ` | suggested: ${t.suggestedAction}`;
        context += '\n';
      }
    }

    return context;
  }
}

// --- Adaptive Card templates for rich Teams messages ---

const STATUS_COLORS: Record<string, { color: string; icon: string; label: string }> = {
  pending:           { color: 'default',   icon: '⏳', label: 'Pending' },
  diagnosing:        { color: 'accent',    icon: '🔍', label: 'Diagnosing' },
  awaiting_approval: { color: 'warning',   icon: '⚡', label: 'Awaiting Approval' },
  in_progress:       { color: 'accent',    icon: '🔧', label: 'In Progress' },
  resolved:          { color: 'good',      icon: '✅', label: 'Resolved' },
  escalated:         { color: 'attention',  icon: '🚨', label: 'Escalated' },
};

export class TeamsCards {
  // Generic status update card
  static statusUpdate(status: string, message: string, ticketId: string): Record<string, unknown> {
    const s = STATUS_COLORS[status] || STATUS_COLORS.pending;

    // Split message into sections if it has markdown headers
    const sections = this.parseMessageSections(message);

    const body: Record<string, unknown>[] = [
      // Header with status badge
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            items: [{ type: 'TextBlock', text: s.icon, size: 'large' }],
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              { type: 'TextBlock', text: 'BLUE.Y', weight: 'bolder', size: 'medium', color: 'accent' },
              { type: 'TextBlock', text: s.label, spacing: 'none', isSubtle: true, size: 'small' },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            items: [{ type: 'TextBlock', text: `#${ticketId.split('-').pop()}`, isSubtle: true, size: 'small' }],
          },
        ],
      },
      // Divider
      {
        type: 'ColumnSet',
        separator: true,
        spacing: 'small',
        columns: [],
      },
    ];

    // Add content sections
    for (const section of sections) {
      if (section.heading) {
        body.push({
          type: 'TextBlock',
          text: section.heading,
          weight: 'bolder',
          size: 'small',
          spacing: 'medium',
          color: 'accent',
        });
      }
      body.push({
        type: 'TextBlock',
        text: section.content,
        wrap: true,
        spacing: section.heading ? 'small' : 'medium',
        size: 'default',
      });
    }

    // Add timestamp footer
    body.push({
      type: 'TextBlock',
      text: `Updated: ${new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })} SGT`,
      isSubtle: true,
      size: 'small',
      spacing: 'medium',
      separator: true,
    });

    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body,
    };
  }

  // Diagnosis card with structured findings
  static diagnosis(diagnosis: string, status: string, ticketId: string, opts?: {
    screenshotAnalysis?: string;
    suggestedAction?: string;
    jiraUrl?: string;
    jiraKey?: string;
  }): Record<string, unknown> {
    const s = STATUS_COLORS[status] || STATUS_COLORS.diagnosing;

    const body: Record<string, unknown>[] = [
      // Header
      {
        type: 'ColumnSet',
        columns: [
          { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: s.icon, size: 'large' }] },
          {
            type: 'Column', width: 'stretch',
            items: [
              { type: 'TextBlock', text: 'BLUE.Y Diagnosis', weight: 'bolder', size: 'medium', color: 'accent' },
              { type: 'TextBlock', text: s.label, spacing: 'none', isSubtle: true, size: 'small' },
            ],
          },
        ],
      },
    ];

    // Screenshot analysis
    if (opts?.screenshotAnalysis) {
      body.push(
        { type: 'TextBlock', text: '📸 Screenshot Analysis', weight: 'bolder', size: 'small', color: 'accent', spacing: 'medium', separator: true },
        { type: 'TextBlock', text: opts.screenshotAnalysis, wrap: true, spacing: 'small', isSubtle: true },
      );
    }

    // Diagnosis
    body.push(
      { type: 'TextBlock', text: '🧠 Analysis', weight: 'bolder', size: 'small', color: 'accent', spacing: 'medium', separator: true },
      { type: 'TextBlock', text: diagnosis, wrap: true, spacing: 'small' },
    );

    // Suggested action
    if (opts?.suggestedAction) {
      body.push(
        { type: 'TextBlock', text: '🔧 Recommended Action', weight: 'bolder', size: 'small', color: 'accent', spacing: 'medium', separator: true },
        {
          type: 'Container',
          style: 'emphasis',
          items: [{ type: 'TextBlock', text: opts.suggestedAction, wrap: true, weight: 'bolder' }],
        },
      );
    }

    // Status message based on current state
    if (status === 'awaiting_approval') {
      body.push({
        type: 'Container',
        style: 'warning',
        spacing: 'medium',
        items: [{ type: 'TextBlock', text: '⏳ Sent to ops team for approval. You\'ll get an update once they respond.', wrap: true, size: 'small' }],
      });
    } else if (status === 'resolved') {
      body.push({
        type: 'Container',
        style: 'good',
        spacing: 'medium',
        items: [{ type: 'TextBlock', text: '✅ No immediate action required. If the issue persists, let me know!', wrap: true, size: 'small' }],
      });
    }

    // Jira link
    if (opts?.jiraUrl && opts?.jiraKey) {
      body.push({
        type: 'ActionSet',
        spacing: 'medium',
        actions: [{ type: 'Action.OpenUrl', title: `📋 ${opts.jiraKey} — View in Jira`, url: opts.jiraUrl }],
      });
    }

    // Footer
    body.push({
      type: 'TextBlock',
      text: `Ticket: ${ticketId} • ${new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })} SGT`,
      isSubtle: true, size: 'small', spacing: 'medium', separator: true,
    });

    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body,
    };
  }

  // Diagnostic results card (after /yes → diagnose)
  static diagnosticResults(podName: string, namespace: string, analysis: string, ticketId: string): Record<string, unknown> {
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [
        {
          type: 'ColumnSet',
          columns: [
            { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '🔬', size: 'large' }] },
            {
              type: 'Column', width: 'stretch',
              items: [
                { type: 'TextBlock', text: 'Diagnostic Results', weight: 'bolder', size: 'medium', color: 'accent' },
                { type: 'TextBlock', text: `${namespace}/${podName}`, spacing: 'none', isSubtle: true, size: 'small', fontType: 'monospace' },
              ],
            },
          ],
        },
        { type: 'TextBlock', text: '📊 Findings', weight: 'bolder', size: 'small', color: 'accent', spacing: 'medium', separator: true },
        { type: 'TextBlock', text: analysis, wrap: true, spacing: 'small' },
        {
          type: 'Container',
          style: 'good',
          spacing: 'medium',
          items: [{ type: 'TextBlock', text: '✅ Diagnostic complete. The ops team has been notified.', wrap: true, size: 'small' }],
        },
        {
          type: 'TextBlock',
          text: `${new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })} SGT`,
          isSubtle: true, size: 'small', spacing: 'medium', separator: true,
        },
      ],
    };
  }

  // Action progress card (restart/scale in progress)
  static actionProgress(action: string, target: string, eta: string): Record<string, unknown> {
    const actionLabel = action === 'restart' ? '🔄 Restarting' : action === 'scale' ? '📈 Scaling' : `🔧 ${action}`;
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [
        {
          type: 'ColumnSet',
          columns: [
            { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '🔧', size: 'large' }] },
            {
              type: 'Column', width: 'stretch',
              items: [
                { type: 'TextBlock', text: `${actionLabel} ${target}`, weight: 'bolder', size: 'medium' },
                { type: 'TextBlock', text: 'Approved by ops team', spacing: 'none', isSubtle: true, size: 'small' },
              ],
            },
          ],
        },
        {
          type: 'FactSet',
          separator: true,
          spacing: 'medium',
          facts: [
            { title: 'Action', value: action.charAt(0).toUpperCase() + action.slice(1) },
            { title: 'Target', value: target },
            { title: 'ETA', value: eta },
            { title: 'Status', value: '⏳ In progress...' },
          ],
        },
        {
          type: 'Container',
          style: 'accent',
          spacing: 'medium',
          items: [{ type: 'TextBlock', text: "I'll update you automatically once it's verified healthy.", wrap: true, size: 'small' }],
        },
      ],
    };
  }

  // Resolution card (fix verified)
  static resolved(target: string, message: string, elapsed?: number): Record<string, unknown> {
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [
        {
          type: 'ColumnSet',
          columns: [
            { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '✅', size: 'large' }] },
            {
              type: 'Column', width: 'stretch',
              items: [
                { type: 'TextBlock', text: 'Issue Resolved', weight: 'bolder', size: 'medium', color: 'good' },
                { type: 'TextBlock', text: target, spacing: 'none', isSubtle: true, size: 'small' },
              ],
            },
          ],
        },
        { type: 'TextBlock', text: message, wrap: true, spacing: 'medium', separator: true },
        ...(elapsed ? [{
          type: 'FactSet' as const,
          spacing: 'medium' as const,
          facts: [{ title: 'Resolved in', value: `${elapsed} seconds` }],
        }] : []),
        {
          type: 'TextBlock',
          text: `${new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })} SGT`,
          isSubtle: true, size: 'small', spacing: 'medium', separator: true,
        },
      ],
    };
  }

  // Parse markdown-ish message into sections
  private static parseMessageSections(message: string): { heading?: string; content: string }[] {
    const sections: { heading?: string; content: string }[] = [];
    // Split on **Header:** patterns
    const parts = message.split(/\*\*([^*]+):\*\*\s*/);

    if (parts.length <= 1) {
      // No markdown headers — return as single section
      return [{ content: message }];
    }

    // First part (before any header) as intro
    if (parts[0].trim()) {
      sections.push({ content: parts[0].trim() });
    }

    // Pairs of heading + content
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i];
      const content = (parts[i + 1] || '').trim();
      if (content) {
        sections.push({ heading, content });
      }
    }

    return sections.length > 0 ? sections : [{ content: message }];
  }
}
