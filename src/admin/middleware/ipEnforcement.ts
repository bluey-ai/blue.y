// @premium — BlueOnion internal only. (BLY-52)
// VPN/IP enforcement — must run BEFORE session check.
// If the allowlist is non-empty and the request IP is not in any CIDR, returns
// a generic 401 (never hints about VPN — security requirement).
import { Request, Response, NextFunction } from 'express';
import ipaddr from 'ipaddr.js';
import { listAllowlist } from '../db';
import { logger } from '../../utils/logger';

function parseRequestIp(req: Request): string {
  // Trust X-Forwarded-For behind ALB/nginx (first entry = client IP)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return req.socket.remoteAddress ?? '127.0.0.1';
}

function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const addr = ipaddr.parse(ip);
    const [range, bits] = ipaddr.parseCIDR(cidr);
    // Both must be same kind (IPv4/IPv6), or handle IPv4-mapped IPv6
    const addrKind = addr.kind();
    const rangeKind = range.kind();
    if (addrKind === rangeKind) {
      return addr.match([range, bits]);
    }
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) vs IPv4 CIDR
    if (addrKind === 'ipv6' && rangeKind === 'ipv4') {
      const v6 = addr as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        return v6.toIPv4Address().match([range as ipaddr.IPv4, bits]);
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function ipEnforcementMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowlist = listAllowlist();

  // If allowlist is empty, enforcement is disabled (open to all — useful during initial setup)
  if (allowlist.length === 0) { next(); return; }

  const clientIp = parseRequestIp(req);
  const allowed = allowlist.some(entry => ipInCidr(clientIp, entry.cidr));

  if (!allowed) {
    logger.warn(`[admin] IP enforcement: blocked ${clientIp} — not in allowlist`);
    // Generic error — never reveal VPN requirement (security requirement BLY-52)
    res.status(401).json({ error: 'Invalid credentials or access not permitted' });
    return;
  }

  next();
}
