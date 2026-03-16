// @premium — BlueOnion internal only.
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

const NONCE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (matches JWT expiry)

// Single-use nonces: nonce → expiry timestamp
const nonces = new Map<string, number>();

// Clean up expired nonces every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of nonces) {
    if (now > exp) nonces.delete(nonce);
  }
}, 10 * 60 * 1000).unref();

export interface MagicLinkPayload {
  sub: string;      // platform user ID (e.g. Telegram numeric ID)
  platform: string; // 'telegram' | 'slack' | 'teams'
  name: string;     // display name
  nonce: string;    // single-use token
}

export function generateMagicLink(userId: string, platform: string, displayName: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);

  const payload: MagicLinkPayload = { sub: userId, platform, name: displayName, nonce };
  const token = jwt.sign(payload, config.admin.jwtSecret, { expiresIn: '4h' });

  logger.info(`[admin] Magic link generated for ${platform}:${userId} (${displayName})`);
  return `${config.admin.host}/admin/auth?token=${encodeURIComponent(token)}`;
}

export function validateMagicLink(token: string): MagicLinkPayload | null {
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret) as MagicLinkPayload;
    if (!nonces.has(payload.nonce)) {
      logger.warn('[admin] Magic link used with unknown or already-consumed nonce');
      return null;
    }
    nonces.delete(payload.nonce); // single-use: consume immediately
    logger.info(`[admin] Magic link validated for ${payload.platform}:${payload.sub}`);
    return payload;
  } catch (e) {
    logger.warn('[admin] Magic link validation failed', e);
    return null;
  }
}

export function generateSessionToken(userId: string, platform: string, name: string): string {
  return jwt.sign(
    { sub: userId, platform, name, type: 'session' },
    config.admin.jwtSecret,
    { expiresIn: `${config.admin.sessionTtlHours}h` },
  );
}

export function validateSession(token: string): { sub: string; name: string; platform: string } | null {
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret) as Record<string, string>;
    if (payload.type !== 'session') return null;
    if (!payload.sub || !payload.name || !payload.platform) return null;
    return { sub: payload.sub, name: payload.name, platform: payload.platform };
  } catch {
    return null;
  }
}
