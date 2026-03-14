/**
 * Slack Adapter — STUB
 * Full implementation: HUBS-6146
 *
 * Normalises a @slack/bolt event into CallerIdentity.
 * Supports slash commands (/bluey <cmd>) and @mentions.
 */

import { CallerIdentity, Platform } from '../rbac';

export interface SlackEventLike {
  user?: string;       // Slack user ID (e.g. U01ABC123)
  text?: string;
  username?: string;
}

export function adaptSlackMessage(event: SlackEventLike): CallerIdentity {
  return {
    platform: 'slack' as Platform,
    id: event.user ?? '',
    displayName: event.username ?? event.user ?? '',
    rawMessage: event.text ?? '',
  };
}
