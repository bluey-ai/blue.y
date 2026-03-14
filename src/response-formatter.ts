/**
 * ResponseFormatter — formats the same data differently depending on the caller's role.
 *
 * Admin/Operator: technical output (pod names, namespaces, CPU millicores, MB, etc.)
 * User:           plain English (no K8s jargon, service names only, friendly timestamps)
 *

 */

import { Role } from './rbac';

export interface ServiceStatus {
  name: string;          // friendly name e.g. "Login", "Main platform"
  deployment: string;    // k8s deployment name
  healthy: boolean;
  pods?: { ready: number; total: number };
  cpuMilli?: number;
  memoryMB?: number;
  memLimitMB?: number;
}

export interface ClusterStatus {
  services: ServiceStatus[];
  totalPods: number;
  healthyPods: number;
  nodeCpuPct?: number;
  nodeMemPct?: number;
  nodeCount?: number;
}

export interface IncidentSummary {
  ts: Date;
  severity: 'critical' | 'high' | 'warning';
  deployment: string;
  friendlyName: string;
  description: string;   // technical description
  durationMs?: number;
  resolved: boolean;
}

export class ResponseFormatter {
  // ─────────────────────────────────────────
  // /status
  // ─────────────────────────────────────────

  formatStatus(status: ClusterStatus, role: Role): string {
    if (role === 'user') return this.statusForUser(status);
    return this.statusForAdmin(status);
  }

  private statusForAdmin(s: ClusterStatus): string {
    const allHealthy = s.services.every((svc) => svc.healthy);
    const icon = allHealthy ? '🟢' : '🔴';

    let msg = `${icon} <b>Cluster: ${s.healthyPods}/${s.totalPods} pods running</b>\n`;
    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    for (const svc of s.services) {
      const svcIcon = svc.healthy ? '✅' : '🔴';
      const pods = svc.pods ? `${svc.pods.ready}/${svc.pods.total}` : '?/?';
      const cpu = svc.cpuMilli !== undefined ? `CPU: ${svc.cpuMilli}m` : '';
      const mem = svc.memoryMB !== undefined
        ? `Mem: ${svc.memoryMB}MB${svc.memLimitMB ? ` (${Math.round((svc.memoryMB / svc.memLimitMB) * 100)}%)` : ''}`
        : '';
      const metrics = [cpu, mem].filter(Boolean).join('  ');
      msg += `${svcIcon} <code>${svc.deployment}</code>  <b>${pods}</b>`;
      if (metrics) msg += `  ${metrics}`;
      msg += '\n';
    }

    if (s.nodeCpuPct !== undefined) {
      msg += `\nNodes: ${s.nodeCount ?? '?'} | CPU ${s.nodeCpuPct}% | Mem ${s.nodeMemPct ?? '?'}%`;
    }
    return msg;
  }

  private statusForUser(s: ClusterStatus): string {
    const allHealthy = s.services.every((svc) => svc.healthy);
    const now = new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });

    if (allHealthy) {
      let msg = `✅ All systems are running normally.\n\n`;
      msg += s.services.map((svc) => `${svc.name}  ✅`).join('\n');
      msg += `\n\nLast checked: ${now} SGT`;
      return msg;
    }

    const down = s.services.filter((svc) => !svc.healthy);
    let msg = `⚠️ Some services are experiencing issues.\n\n`;
    for (const svc of s.services) {
      msg += `${svc.name}  ${svc.healthy ? '✅' : '🔴 Down'}\n`;
    }
    msg += `\nOur team has been notified and is working on it.`;
    msg += `\nLast checked: ${now} SGT`;
    return msg;
  }

  // ─────────────────────────────────────────
  // /incidents
  // ─────────────────────────────────────────

  formatIncidents(incidents: IncidentSummary[], role: Role): string {
    if (role === 'user') return this.incidentsForUser(incidents);
    return this.incidentsForAdmin(incidents);
  }

  private incidentsForAdmin(incidents: IncidentSummary[]): string {
    if (incidents.length === 0) return '✅ No incidents recorded.';

    let msg = `<b>🚨 Recent Incidents (${incidents.length})</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const inc of incidents.slice(0, 10)) {
      const ts = inc.ts.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'short', timeStyle: 'short' });
      const icon = inc.severity === 'critical' ? '🔴' : inc.severity === 'high' ? '🟡' : '🟠';
      const status = inc.resolved ? '✅ Resolved' : '🔴 Ongoing';
      const dur = inc.durationMs ? ` · ${Math.round(inc.durationMs / 60_000)}m` : '';
      msg += `${icon} <b>${ts}</b>${dur} · ${status}\n`;
      msg += `   <code>${inc.deployment}</code>\n`;
      msg += `   ${inc.description}\n\n`;
    }
    return msg.trim();
  }

  private incidentsForUser(incidents: IncidentSummary[]): string {
    const relevant = incidents.filter((i) => i.friendlyName);
    if (relevant.length === 0) return '✅ No recent outages. Everything has been running smoothly.';

    let msg = `Recent incidents:\n\n`;
    for (const inc of relevant.slice(0, 5)) {
      const ts = inc.ts.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', timeStyle: 'short', dateStyle: 'short' });
      const status = inc.resolved ? 'Resolved' : 'Ongoing';
      const dur = inc.durationMs ? `, lasted ~${Math.round(inc.durationMs / 60_000)} min` : '';
      msg += `• ${inc.friendlyName} was down at ${ts}${dur} — ${status}\n`;
    }
    return msg.trim();
  }

  // ─────────────────────────────────────────
  // Alerts (sent proactively by monitors)
  // ─────────────────────────────────────────

  formatUserImpactAlert(friendlyName: string, down: boolean): string {
    if (down) {
      return `⚠️ The <b>${friendlyName}</b> service is currently unavailable.\nOur team has been notified and is working on it.\nWe'll update you when it's resolved.`;
    }
    return `✅ The <b>${friendlyName}</b> service has been restored and is working normally.`;
  }

  // ─────────────────────────────────────────
  // /help
  // ─────────────────────────────────────────

  formatHelp(role: Role, platform: string): string {
    if (role === 'user') return this.helpForUser(platform);
    if (role === 'operator') return this.helpForOperator();
    return this.helpForAdmin();
  }

  private helpForUser(platform: string): string {
    const isWhatsApp = platform === 'whatsapp';
    if (isWhatsApp) {
      return `Hi! Here's what you can ask me:\n\n` +
        `• status — check if systems are working\n` +
        `• reset my password — reset your AWS login\n` +
        `• any incidents? — recent outages\n` +
        `• ping login — check if a service is up`;
    }
    return `Here's what I can do for you:\n\n` +
      `<b>/status</b> — Check if all systems are running\n` +
      `<b>/ping</b> &lt;service&gt; — Check if a specific service is up\n` +
      `<b>/incidents</b> — Recent outages and their status\n` +
      `<b>/reset password</b> — Reset your AWS console password\n\n` +
      `Need more access? Contact your DevOps team.`;
  }

  private helpForOperator(): string {
    return `<b>🔧 BLUE.Y Commands (Operator)</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>Monitor</b>\n` +
      `/status /nodes /hpa /resources /load /doris /loki\n\n` +
      `<b>Pods</b>\n` +
      `/logs &lt;pod&gt;  /describe &lt;pod&gt;  /events  /deployments\n\n` +
      `<b>Actions</b> (require /yes confirm)\n` +
      `/restart &lt;deploy&gt;  /scale &lt;deploy&gt; &lt;N&gt;  /rollout &lt;deploy&gt;\n\n` +
      `<b>Reports</b>\n` +
      `/incidents  /jira  /report-issue  /tickets`;
  }

  private helpForAdmin(): string {
    return `<b>🛡️ BLUE.Y Commands (Admin)</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>Monitor</b>\n` +
      `/status /nodes /hpa /resources /load /doris /backend /rds /jobs\n\n` +
      `<b>Pods</b>\n` +
      `/logs /describe /events /diagnose /deployments /restarts /efficiency\n\n` +
      `<b>Actions</b> (require /yes)\n` +
      `/restart /scale /rollout /build /sleep /wake\n\n` +
      `<b>Security</b>\n` +
      `/waf /threats /block &lt;ip&gt; /unblock &lt;ip&gt; /scan &lt;repo&gt;\n\n` +
      `<b>Reports</b>\n` +
      `/incidents /email /jira /report /costs /backups\n\n` +
      `<b>Database</b>\n` +
      `/db &lt;question&gt;  /query &lt;sql&gt;  /tables\n\n` +
      `<code>/cheatsheet</code> for full reference`;
  }

  // ─────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────

  /** Strip HTML tags for plain-text platforms (WhatsApp). */
  static stripHtml(html: string): string {
    return html
      .replace(/<b>(.*?)<\/b>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<[^>]+>/g, '');
  }
}
