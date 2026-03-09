import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
  TurnContext,
  ActivityTypes,
  ConversationReference,
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
      await context.sendActivity(
        '**BLUE.Y - IT Support Assistant** \n\n' +
        'I can help you with infrastructure issues. Just describe your problem in plain English:\n\n' +
        '- "The website is slow"\n' +
        '- "PDF service is not working"\n' +
        '- "I can\'t log in to the platform"\n' +
        '- "Backend is returning errors"\n' +
        '- "Data is not loading on the dashboard"\n\n' +
        'I\'ll diagnose the issue and work with the ops team to fix it. ' +
        'You\'ll get updates right here in Teams.\n\n' +
        '**Commands:**\n' +
        '- `status` - Quick cluster health check\n' +
        '- `smoketest` - Test all production URLs\n' +
        '- `securityscan` - OWASP security header scan\n' +
        '- `help` - Show this message\n\n' +
        '**Tip:** You can also attach screenshots — I\'ll analyze them automatically!',
      );
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

  // Update ticket status and notify the user
  async updateTicket(ticketId: string, status: TeamsTicket['status'], message?: string): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return;

    ticket.status = status;

    if (message) {
      await this.replyToTicket(ticketId, message);
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
