import axios from 'axios';
import https from 'https';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface SmokeTestResult {
  name: string;
  url: string;
  status: number | null;
  responseTime: number;
  healthy: boolean;
  error?: string;
  sslDaysLeft?: number;
}

export interface SecurityHeader {
  name: string;
  present: boolean;
  value?: string;
  severity: 'critical' | 'warning' | 'info';
  recommendation?: string;
}

export interface SecurityScanResult {
  url: string;
  name: string;
  headers: SecurityHeader[];
  sslValid: boolean;
  sslDaysLeft: number;
  sslIssuer?: string;
  score: number; // 0-100
  grade: string; // A, B, C, D, F
  issues: string[];
}

const SECURITY_HEADERS = [
  { name: 'Strict-Transport-Security', severity: 'critical' as const, desc: 'HSTS — forces HTTPS' },
  { name: 'X-Content-Type-Options', severity: 'warning' as const, desc: 'Prevents MIME sniffing' },
  { name: 'X-Frame-Options', severity: 'warning' as const, desc: 'Clickjacking protection' },
  { name: 'Content-Security-Policy', severity: 'critical' as const, desc: 'CSP — XSS protection' },
  { name: 'X-XSS-Protection', severity: 'info' as const, desc: 'Legacy XSS filter' },
  { name: 'Referrer-Policy', severity: 'info' as const, desc: 'Controls referrer info' },
  { name: 'Permissions-Policy', severity: 'info' as const, desc: 'Controls browser features' },
  { name: 'X-Permitted-Cross-Domain-Policies', severity: 'info' as const, desc: 'Flash/PDF cross-domain' },
];

// Headers that should NOT be present (information disclosure)
const BAD_HEADERS = [
  { name: 'Server', severity: 'info' as const, desc: 'Server version disclosure' },
  { name: 'X-Powered-By', severity: 'warning' as const, desc: 'Technology disclosure' },
  { name: 'X-AspNet-Version', severity: 'warning' as const, desc: 'ASP.NET version disclosure' },
];

export class QAClient {
  // Run smoke tests on all production URLs
  async smokeTest(): Promise<SmokeTestResult[]> {
    const results: SmokeTestResult[] = [];

    const promises = config.productionUrls.map(async (endpoint: { name: string; url: string; expect?: number }) => {
      const start = Date.now();
      try {
        const response = await axios.get(endpoint.url, {
          timeout: 15000,
          maxRedirects: 0, // Don't follow redirects — we want to see the actual status
          validateStatus: () => true, // Don't throw on non-2xx
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          headers: {
            'User-Agent': 'BLUE.Y-SmokeTest/1.0',
          },
        });

        const responseTime = Date.now() - start;
        const sslDays = await this.checkSSLExpiry(endpoint.url).catch(() => -1);

        // A service is healthy if it returns the expected status code.
        // Some services return 404 (no root route), 302 (redirect to login), or 403 (auth required)
        // — these are normal and expected when the service is running fine.
        const expectedStatus = endpoint.expect || 200;
        const isHealthy = response.status === expectedStatus
          || (expectedStatus === 200 && response.status >= 200 && response.status < 400);

        results.push({
          name: endpoint.name,
          url: endpoint.url,
          status: response.status,
          responseTime,
          healthy: isHealthy,
          sslDaysLeft: sslDays >= 0 ? sslDays : undefined,
        });
      } catch (err) {
        results.push({
          name: endpoint.name,
          url: endpoint.url,
          status: null,
          responseTime: Date.now() - start,
          healthy: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    });

    await Promise.all(promises);
    return results;
  }

  // Run security header scan on a URL
  async securityScan(url?: string): Promise<SecurityScanResult[]> {
    const targets = url
      ? [{ name: url, url }]
      : config.productionUrls;

    const results: SecurityScanResult[] = [];

    for (const target of targets) {
      try {
        const result = await this.scanUrl(target.name, target.url);
        results.push(result);
      } catch (err) {
        logger.error(`[QA] Security scan failed for ${target.url}`, err);
        results.push({
          url: target.url,
          name: target.name,
          headers: [],
          sslValid: false,
          sslDaysLeft: 0,
          score: 0,
          grade: 'F',
          issues: [`Scan failed: ${err instanceof Error ? err.message : 'Unknown'}`],
        });
      }
    }

    return results;
  }

  private async scanUrl(name: string, url: string): Promise<SecurityScanResult> {
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: { 'User-Agent': 'BLUE.Y-SecurityScan/1.0' },
    });

    const responseHeaders = response.headers;
    const headers: SecurityHeader[] = [];
    const issues: string[] = [];
    let score = 100;

    // Check required security headers
    for (const h of SECURITY_HEADERS) {
      const value = responseHeaders[h.name.toLowerCase()];
      const present = !!value;
      headers.push({
        name: h.name,
        present,
        value: typeof value === 'string' ? value : undefined,
        severity: h.severity,
        recommendation: present ? undefined : `Missing ${h.name} (${h.desc})`,
      });

      if (!present) {
        if (h.severity === 'critical') { score -= 20; issues.push(`Missing ${h.name}`); }
        else if (h.severity === 'warning') { score -= 10; issues.push(`Missing ${h.name}`); }
        else { score -= 5; }
      }
    }

    // Check headers that should NOT be present
    for (const h of BAD_HEADERS) {
      const value = responseHeaders[h.name.toLowerCase()];
      if (value) {
        headers.push({
          name: h.name,
          present: true,
          value: typeof value === 'string' ? value : undefined,
          severity: h.severity,
          recommendation: `Remove ${h.name} header (${h.desc})`,
        });
        if (h.severity === 'warning') { score -= 10; issues.push(`${h.name} exposed: ${value}`); }
        else { score -= 5; issues.push(`${h.name} header present`); }
      }
    }

    // Check SSL
    const sslDaysLeft = await this.checkSSLExpiry(url).catch(() => -1);
    const sslValid = sslDaysLeft > 0;
    if (sslDaysLeft <= 0) {
      score -= 20;
      issues.push('SSL certificate invalid or expired');
    } else if (sslDaysLeft < 30) {
      score -= 10;
      issues.push(`SSL expires in ${sslDaysLeft} days`);
    }

    // Check for HTTPS redirect
    if (url.startsWith('https://')) {
      const httpUrl = url.replace('https://', 'http://');
      try {
        const httpResp = await axios.get(httpUrl, {
          timeout: 10000,
          maxRedirects: 0,
          validateStatus: () => true,
        });
        if (httpResp.status !== 301 && httpResp.status !== 308) {
          score -= 10;
          issues.push('HTTP does not redirect to HTTPS with 301');
        }
      } catch {
        // Connection refused is fine — means HTTP is disabled
      }
    }

    score = Math.max(0, score);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

    return {
      url,
      name,
      headers,
      sslValid,
      sslDaysLeft: sslDaysLeft >= 0 ? sslDaysLeft : 0,
      score,
      grade,
      issues,
    };
  }

  // Check SSL certificate expiry
  private checkSSLExpiry(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        const hostname = new URL(url).hostname;
        const options = {
          host: hostname,
          port: 443,
          method: 'HEAD',
          rejectUnauthorized: false,
        };

        const req = https.request(options, (res) => {
          const cert = (res.socket as import('tls').TLSSocket).getPeerCertificate();
          if (cert && cert.valid_to) {
            const expiry = new Date(cert.valid_to);
            const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            resolve(daysLeft);
          } else {
            reject(new Error('No certificate'));
          }
          res.destroy();
        });

        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // Format smoke test results for Telegram (HTML)
  formatSmokeTestTelegram(results: SmokeTestResult[]): string {
    const healthy = results.filter((r) => r.healthy).length;
    const total = results.length;
    const allHealthy = healthy === total;

    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🧪 <b>SMOKE TEST</b> ${allHealthy ? '✅ ALL PASS' : `⚠️ ${total - healthy} FAILING`}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const r of results) {
      const icon = r.healthy ? '✅' : '❌';
      const statusText = r.status ? `${r.status}` : 'TIMEOUT';
      const speed = r.responseTime < 500 ? '⚡' : r.responseTime < 2000 ? '🟡' : '🐢';
      msg += `${icon} <b>${r.name}</b>\n`;
      msg += `   ${statusText} | ${speed} ${r.responseTime}ms`;
      if (r.sslDaysLeft !== undefined) {
        const sslIcon = r.sslDaysLeft > 30 ? '🔒' : r.sslDaysLeft > 7 ? '⚠️' : '🔴';
        msg += ` | ${sslIcon} SSL: ${r.sslDaysLeft}d`;
      }
      if (r.error) msg += `\n   <i>${r.error.substring(0, 80)}</i>`;
      msg += '\n';
    }

    msg += `\n📊 ${healthy}/${total} services healthy`;
    return msg;
  }

  // Format security scan results for Telegram (HTML)
  formatSecurityScanTelegram(results: SecurityScanResult[]): string {
    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔐 <b>SECURITY SCAN</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const r of results) {
      const gradeIcon = r.grade === 'A' ? '🟢' : r.grade === 'B' ? '🟡' : r.grade === 'C' ? '🟠' : '🔴';
      msg += `${gradeIcon} <b>${r.name}</b> — Grade: <b>${r.grade}</b> (${r.score}/100)\n`;

      if (r.sslDaysLeft > 0) {
        const sslIcon = r.sslDaysLeft > 30 ? '🔒' : '⚠️';
        msg += `   ${sslIcon} SSL: ${r.sslDaysLeft} days left\n`;
      }

      if (r.issues.length > 0) {
        const topIssues = r.issues.slice(0, 3);
        for (const issue of topIssues) {
          msg += `   ⚠️ ${issue}\n`;
        }
        if (r.issues.length > 3) {
          msg += `   ... and ${r.issues.length - 3} more\n`;
        }
      }
      msg += '\n';
    }

    const avgScore = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
    const avgGrade = avgScore >= 90 ? 'A' : avgScore >= 75 ? 'B' : avgScore >= 60 ? 'C' : avgScore >= 40 ? 'D' : 'F';
    msg += `📊 Average security score: <b>${avgGrade}</b> (${avgScore}/100)`;
    return msg;
  }

  // Format smoke test results for Teams (Markdown)
  formatSmokeTestTeams(results: SmokeTestResult[]): string {
    const healthy = results.filter((r) => r.healthy).length;
    const total = results.length;

    let msg = `**Smoke Test Results** — ${healthy}/${total} passing\n\n`;

    for (const r of results) {
      const icon = r.healthy ? '✅' : '❌';
      const statusText = r.status ? `${r.status}` : 'TIMEOUT';
      msg += `${icon} **${r.name}** — ${statusText} (${r.responseTime}ms)`;
      if (r.sslDaysLeft !== undefined && r.sslDaysLeft < 30) {
        msg += ` ⚠️ SSL expires in ${r.sslDaysLeft} days`;
      }
      if (r.error) msg += ` — ${r.error}`;
      msg += '\n';
    }

    return msg;
  }

  // Format security scan results for Teams (Markdown)
  formatSecurityScanTeams(results: SecurityScanResult[]): string {
    let msg = `**Security Scan Results**\n\n`;

    for (const r of results) {
      msg += `**${r.name}** — Grade: **${r.grade}** (${r.score}/100)\n`;
      if (r.issues.length > 0) {
        for (const issue of r.issues.slice(0, 5)) {
          msg += `- ⚠️ ${issue}\n`;
        }
      } else {
        msg += `- ✅ No issues found\n`;
      }
      msg += '\n';
    }

    return msg;
  }
}
