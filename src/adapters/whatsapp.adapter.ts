/**
 * WhatsApp Adapter — STUB
 * Full implementation: BLY-3
 *
 * Normalises a Twilio WhatsApp webhook payload into CallerIdentity.
 * User identity = E.164 phone number (e.g. +6512345678).
 * The 'From' field from Twilio is "whatsapp:+6512345678" — strip the prefix.
 */

import { CallerIdentity, Platform } from '../rbac';

export interface TwilioWhatsAppPayload {
  From?: string;   // "whatsapp:+6512345678"
  Body?: string;
  ProfileName?: string;
}

export function adaptWhatsAppMessage(payload: TwilioWhatsAppPayload): CallerIdentity {
  const raw = payload.From ?? '';
  const id = raw.startsWith('whatsapp:') ? raw.slice('whatsapp:'.length) : raw;
  return {
    platform: 'whatsapp' as Platform,
    id,
    displayName: payload.ProfileName ?? id,
    rawMessage: payload.Body ?? '',
  };
}
