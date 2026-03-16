// @premium — BlueOnion internal only. (BLY-61)
// License key system: RS256-signed JWT with seats + expiry.
// Verified locally using an embedded public key (no phone-home).
// Default: 10 seats. Extended: $2.99/user/month.
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

// ── Embedded public key ───────────────────────────────────────────────────────
// Replace with actual RSA public key in production builds.
// The private key (for signing) is held by BlueOnion and never shipped.
const LICENSE_PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY ?? `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1TdgTuXOVl9jbxK+l+x2
u0ZsvAXcRAcuUCw8e3B/E0fpmmJnHz/mtMqyxf94MZcH0qYJ5tKMyJTn0F8IIu4v
65tb+0Ee8kafwpV2BBqnWdNavFn4z02sjAd3JSFmddsiGbkLanN4jT+eNXh1u9oJ
TE1N6VKjw+Uw9mNZoZpQLmqzSg79cO3eEcNpnWgA3rnHk4zo4tqMqNCtvDiFrtwA
d0dRhAqN+SUUyPTf47W9X1XwoaN45j5sBuzaz9emxc69vX4p3KTQa6qMJJeVaH3k
57JoqGBV24qJP+hiDwotEy15JVnXdo05/saLoaO8UYDQuGe5EH8w2PAggcdKBagN
IwIDAQAB
-----END PUBLIC KEY-----`;

export const DEFAULT_SEATS = 10;

export interface LicensePayload {
  seats:     number;   // total authorised seats (DEFAULT_SEATS + purchased)
  expires:   string;   // ISO 8601 date — undefined = perpetual
  plan:      string;   // 'community' | 'premium' | 'enterprise'
  customer?: string;   // customer identifier (email or org ID)
  iss:       string;   // should be 'bluey-license'
}

let cachedLicense: LicensePayload | null = null;
let cacheTs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // re-verify every hour

export function verifyLicenseKey(licenseKey: string): LicensePayload | null {
  try {
    const payload = jwt.verify(licenseKey, LICENSE_PUBLIC_KEY, {
      algorithms: ['RS256'],
    }) as LicensePayload;

    if (payload.iss !== 'bluey-license') {
      logger.warn('[license] Invalid issuer in license key');
      return null;
    }
    if (payload.expires && new Date(payload.expires) < new Date()) {
      logger.warn(`[license] License key expired on ${payload.expires}`);
      return null;
    }
    return payload;
  } catch (e: any) {
    logger.warn('[license] License key verification failed:', e?.message);
    return null;
  }
}

/**
 * Returns the active license. If ADMIN_LICENSE_KEY env var is set, tries to verify it.
 * Falls back to default free tier (10 seats, community plan).
 */
export function getActiveLicense(): LicensePayload {
  const now = Date.now();
  if (cachedLicense && now - cacheTs < CACHE_TTL_MS) return cachedLicense;

  const licenseKey = process.env.ADMIN_LICENSE_KEY;
  if (licenseKey) {
    const verified = verifyLicenseKey(licenseKey);
    if (verified) {
      cachedLicense = verified;
      cacheTs = now;
      logger.info(`[license] Valid license: ${verified.plan}, ${verified.seats} seats, expires ${verified.expires ?? 'never'}`);
      return verified;
    }
    logger.warn('[license] Invalid or expired license key — falling back to free tier (10 seats)');
  }

  // Free tier defaults
  cachedLicense = { seats: DEFAULT_SEATS, expires: '', plan: 'community', iss: 'bluey-license' };
  cacheTs = now;
  return cachedLicense;
}

/** How many seats are authorised by the current license. */
export function getAuthorisedSeats(): number {
  return getActiveLicense().seats;
}
