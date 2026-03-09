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

export interface TeamsTicket {
  id: string;
  userName: string;
  userMessage: string;
  conversationRef: Partial<ConversationReference>;
  diagnosis?: string;
  suggestedAction?: string;
  status: 'pending' | 'diagnosing' | 'awaiting_approval' | 'resolved' | 'escalated';
  createdAt: Date;
}

// Callback type for when a user sends a message via Teams
type OnUserReportCallback = (ticket: TeamsTicket) => Promise<void>;

export class TeamsClient {
  private adapter: CloudAdapter | null = null;
  private onUserReport?: OnUserReportCallback;
  // Store active tickets for cross-channel flow
  private tickets: Map<string, TeamsTicket> = new Map();
  private ticketCounter = 0;

  constructor() {
    if (!config.teams.enabled) {
      logger.info('[Teams] Not configured — Teams integration disabled');
      return;
    }

    const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
      MicrosoftAppId: config.teams.appId,
      MicrosoftAppPassword: config.teams.appPassword,
      MicrosoftAppType: 'MultiTenant',
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

    const text = context.activity.text?.trim() || '';
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
        '- `help` - Show this message',
      );
      return;
    }

    if (cmd === 'status' || cmd === '/status') {
      await context.sendActivity('Checking cluster health for you...');
      // We'll fill this in via the callback
      const ticket = this.createTicket(userName, 'status_check', context);
      ticket.status = 'diagnosing';
      if (this.onUserReport) await this.onUserReport(ticket);
      return;
    }

    // Everything else = user issue report
    await context.sendActivity(
      `Got it, **${userName}**. I'm looking into: "${text}"\n\n` +
      'I\'ll diagnose this and get back to you shortly.',
    );

    const ticket = this.createTicket(userName, text, context);
    logger.info(`[Teams] New ticket ${ticket.id} from ${userName}: ${text}`);

    if (this.onUserReport) {
      await this.onUserReport(ticket);
    }
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
}
