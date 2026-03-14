/**
 * Telegram Adapter — normalises a Telegraf message context into CallerIdentity.
 *
 * The adapter is the boundary between the platform SDK and BLUE.Y's
 * internal command-router. Every platform has its own adapter that
 * extracts: who is calling, from where, and what they said.
 */

import { CallerIdentity, Platform } from '../rbac';

export interface TelegrafLike {
  from?: {
    id?: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message?: { text?: string };
  text?: string;
}

export function adaptTelegramMessage(ctx: TelegrafLike): CallerIdentity {
  const id = String(ctx.from?.id ?? '');
  const firstName = ctx.from?.first_name ?? '';
  const lastName = ctx.from?.last_name ?? '';
  const username = ctx.from?.username ?? '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || id;
  const rawMessage = ctx.text ?? ctx.message?.text ?? '';

  return {
    platform: 'telegram' as Platform,
    id,
    displayName,
    rawMessage,
  };
}
