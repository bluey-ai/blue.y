/**
 * CommandRouter — central dispatcher for all incoming messages across all platforms.
 *
 * Flow:
 *   1. Platform adapter normalizes payload → CallerIdentity
 *   2. CommandRouter.dispatch() is called with CallerIdentity + raw text + reply fn
 *   3. Role resolved via RBAC
 *   4. Unknown caller  → RBAC.unknownCallerMessage()
 *   5. RBAC gate fails → RBAC.deniedMessage()
 *   6. Registered handler found → handler called with CommandContext
 *   7. No handler registered → returns false (caller falls through to legacy main.ts)
 *
 * This router is platform-agnostic. All platform-specific adapters (Telegram,
 * Slack, Teams, WhatsApp) normalize their payloads into CallerIdentity before
 * calling here.
 *

 */

import { RBAC, CallerIdentity, Role } from './rbac';
import { ResponseFormatter } from './response-formatter';
import { logger } from './utils/logger';

export interface CommandContext {
  caller: CallerIdentity;
  role: Role;
  command: string;   // first token, lowercased, e.g. '/status'
  args: string[];    // remaining tokens
  rawText: string;
  /** Send a reply back to the caller on their originating platform/channel. */
  reply: (message: string) => Promise<void>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export class CommandRouter {
  private handlers = new Map<string, CommandHandler>();

  constructor(private rbac: RBAC) {}

  /** Register a command handler. Idempotent — later registration wins. */
  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command.toLowerCase(), handler);
  }

  /**
   * Dispatch an incoming message.
   *
   * @param caller  Normalized identity from the platform adapter
   * @param text    Raw message text
   * @param reply   Platform-specific send function (already knows the chat/channel)
   *
   * @returns true if the command was handled (or rejected), false if no handler
   *          is registered and the caller should fall through to the legacy handler.
   */
  async dispatch(
    caller: CallerIdentity,
    text: string,
    reply: (message: string) => Promise<void>,
  ): Promise<boolean> {
    const role = this.rbac.getRole(caller.platform, caller.id);

    // Unknown caller — not in RBAC config
    if (!role) {
      await reply(RBAC.unknownCallerMessage());
      return true;
    }

    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase().replace(/@\w+/g, ''); // strip @BotName
    const args = parts.slice(1);

    // RBAC gate
    if (!this.rbac.isAllowed(role, command)) {
      const msg = this.rbac.deniedMessage(role, command);
      await reply(this.formatForPlatform(msg, caller.platform));
      return true;
    }

    const handler = this.handlers.get(command);
    if (!handler) {
      // No handler registered — signal to caller to use legacy handler
      return false;
    }

    const ctx: CommandContext = {
      caller,
      role,
      command,
      args,
      rawText: text,
      reply: async (msg: string) => reply(this.formatForPlatform(msg, caller.platform)),
    };

    try {
      await handler(ctx);
    } catch (err) {
      logger.error(`[CommandRouter] Error in handler for ${command}`, err);
      await reply('❌ Something went wrong. Please try again.');
    }

    return true;
  }

  /** Strip HTML for plain-text platforms (WhatsApp). */
  private formatForPlatform(message: string, platform: string): string {
    return platform === 'whatsapp' ? ResponseFormatter.stripHtml(message) : message;
  }
}
