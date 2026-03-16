import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

const FROM_ADDRESS = process.env.EMAIL_FROM || 'noreply@example.com';

// Auto-detect transport: SMTP if SMTP_HOST is set, otherwise SES
const useSmtp = !!process.env.SMTP_HOST;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class EmailClient {
  private ses?: SESClient;
  private smtpTransport?: nodemailer.Transporter;

  constructor() {
    if (useSmtp) {
      this.smtpTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true', // true for port 465
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || '',
        } : undefined,
      });
      logger.info('EmailClient: using SMTP transport');
    } else {
      const sesConfig: ConstructorParameters<typeof SESClient>[0] = {
        region: process.env.SES_REGION || process.env.AWS_REGION || 'ap-southeast-1',
      };
      if (process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY) {
        sesConfig.credentials = {
          accessKeyId: process.env.SES_ACCESS_KEY_ID,
          secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
        };
      }
      this.ses = new SESClient(sesConfig);
      logger.info('EmailClient: using AWS SES transport');
    }
  }

  // Generic send — used by email-templates (BLY-56/67)
  async send(to: string | string[], fromName: string, subject: string, htmlBody: string): Promise<boolean> {
    const toArr = Array.isArray(to) ? to : [to];
    const fromAddr = fromName ? `${fromName} <${FROM_ADDRESS}>` : FROM_ADDRESS;
    try {
      if (useSmtp && this.smtpTransport) {
        await this.smtpTransport.sendMail({
          from: fromAddr,
          to: toArr.join(', '),
          subject,
          html: htmlBody,
          text: htmlBody.replace(/<[^>]*>/g, ''),
        });
      } else if (this.ses) {
        await this.ses.send(new SendEmailCommand({
          Source: fromAddr,
          Destination: { ToAddresses: toArr },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: htmlBody, Charset: 'UTF-8' },
              Text: { Data: htmlBody.replace(/<[^>]*>/g, ''), Charset: 'UTF-8' },
            },
          },
        }));
      }
      logger.info(`[email] Sent "${subject}" to ${toArr.join(', ')}`);
      return true;
    } catch (err) {
      logger.error(`[email] Failed to send "${subject}": ${err}`);
      return false;
    }
  }

  // Build invite email HTML (BLY-56/67)
  buildInviteHtml(vars: {
    inviteeName: string;
    inviterName: string;
    role: string;
    dashboardUrl: string;
    orgName: string;
    welcomeMsg: string;
    footerMsg: string;
  }): string {
    const roleStyle = vars.role === 'superadmin'
      ? 'background:#fbefff;color:#8250df;border:1px solid #d8b9f8;'
      : vars.role === 'admin'
      ? 'background:#ddf4ff;color:#0969da;border:1px solid #b6e3ff;'
      : 'background:#f6f8fa;color:#57606a;border:1px solid #d0d7de;';
    const roleLabel = vars.role.charAt(0).toUpperCase() + vars.role.slice(1);
    const welcomeBlock = vars.welcomeMsg
      ? `<p style="margin:0 0 20px;color:#57606a;font-size:15px;line-height:1.6;">${escHtml(vars.welcomeMsg)}</p>`
      : '';
    const footerLine = vars.footerMsg ? `${escHtml(vars.footerMsg)}<br>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>You've been invited to BLUE.Y</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f6f8fa;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #d0d7de;max-width:560px;">
  <tr>
    <td style="background:#0d1117;padding:28px 40px;text-align:center;">
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto;">
        <tr>
          <td style="vertical-align:middle;">
            <img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20512%20512%22%3E%3Cpolygon%20points%3D%22476%2C256%20366%2C65.5%20146%2C65.5%2036%2C256%20146%2C446.5%20366%2C446.5%22%20fill%3D%22%230D1B4B%22%2F%3E%3Cpolygon%20points%3D%22298%2C112%20224%2C112%20194%2C272%20256%2C272%20218%2C402%20300%2C264%20242%2C264%22%20fill%3D%22white%22%2F%3E%3Cpath%20d%3D%22M%20183%2C364%20Q%20256%2C306%20329%2C364%22%20stroke%3D%22white%22%20stroke-width%3D%2216%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%22256%22%20cy%3D%22378%22%20r%3D%2223%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E" alt="BLUE.Y Logo" width="44" height="44" style="display:block;" />
          </td>
          <td style="padding-left:12px;vertical-align:middle;">
            <span style="font-size:22px;font-weight:700;color:#e6edf3;letter-spacing:-0.3px;">BLUE.Y</span>
          </td>
        </tr>
      </table>
      <p style="margin:8px 0 0;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">Admin Dashboard</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px 28px;">
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#24292f;">Hi ${escHtml(vars.inviteeName)},</h1>
      <p style="margin:0 0 20px;color:#57606a;font-size:15px;line-height:1.6;">
        <strong style="color:#24292f;">${escHtml(vars.inviterName)}</strong> has invited you to the
        <strong style="color:#24292f;">${escHtml(vars.orgName)}</strong> BLUE.Y Admin Dashboard.
      </p>
      ${welcomeBlock}
      <p style="margin:0 0 8px;font-size:13px;color:#57606a;">Your role:</p>
      <p style="margin:0 0 28px;">
        <span style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;${roleStyle}">${escHtml(roleLabel)}</span>
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px;">
        <tr>
          <td style="border-radius:8px;background:#1f6feb;">
            <a href="${vars.dashboardUrl}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:sans-serif;">
              Sign in to Dashboard &#8594;
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0;color:#8b949e;font-size:13px;line-height:1.6;">
        Sign in with your Microsoft or Google account using this email address.<br>
        Your access is active immediately &mdash; no waiting required.
      </p>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 40px 20px;background:#f6f8fa;border-top:1px solid #e1e4e8;">
      <p style="margin:0;font-size:12px;color:#8b949e;line-height:1.6;">
        ${footerLine}
        Powered by <strong>BLUE.Y</strong> &middot;
        <a href="${vars.dashboardUrl}" style="color:#0969da;text-decoration:none;">Open Dashboard</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`;
  }

  async sendIncidentReport(to: string[], subject: string, body: string): Promise<boolean> {
    try {
      if (useSmtp && this.smtpTransport) {
        await this.smtpTransport.sendMail({
          from: FROM_ADDRESS,
          to: to.join(', '),
          subject,
          html: body,
          text: body.replace(/<[^>]*>/g, ''),
        });
      } else if (this.ses) {
        const command = new SendEmailCommand({
          Source: FROM_ADDRESS,
          Destination: { ToAddresses: to },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: body, Charset: 'UTF-8' },
              Text: { Data: body.replace(/<[^>]*>/g, ''), Charset: 'UTF-8' },
            },
          },
        });
        await this.ses.send(command);
      }

      logger.info(`Incident email sent to ${to.join(', ')}`);
      return true;
    } catch (err) {
      logger.error(`Failed to send email: ${err}`);
      return false;
    }
  }

  formatIncidentEmail(incident: {
    monitor?: string;
    pod?: string;
    namespace?: string;
    status?: string;
    analysis?: string;
    logs?: string;
    events?: string;
    description?: string;
    timestamp?: string;
  }): { subject: string; body: string } {
    const ts = incident.timestamp || new Date().toISOString();
    const subject = `[BLUE.Y Incident] ${incident.pod || incident.monitor || 'Cluster Issue'} — ${incident.status || 'Alert'}`;

    const body = `
<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
  <div style="background: #1a1a2e; color: #fff; padding: 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0;">🚨 BLUE.Y Incident Report</h2>
    <p style="margin: 5px 0 0; color: #aaa;">${ts}</p>
  </div>
  <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <table style="width: 100%; border-collapse: collapse;">
      ${incident.pod ? `<tr><td style="padding: 8px 0; font-weight: bold; width: 120px;">Pod</td><td>${incident.namespace}/${incident.pod}</td></tr>` : ''}
      ${incident.status ? `<tr><td style="padding: 8px 0; font-weight: bold;">Status</td><td><span style="color: #e74c3c; font-weight: bold;">${incident.status}</span></td></tr>` : ''}
      ${incident.monitor ? `<tr><td style="padding: 8px 0; font-weight: bold;">Monitor</td><td>${incident.monitor}</td></tr>` : ''}
    </table>

    ${incident.analysis ? `
    <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 8px;">AI Analysis</h3>
    <p>${incident.analysis}</p>
    ` : ''}

    ${incident.description ? `
    <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 8px;">Pod Details</h3>
    <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px;">${incident.description}</pre>
    ` : ''}

    ${incident.logs ? `
    <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 8px;">Recent Logs</h3>
    <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; max-height: 400px;">${incident.logs.substring(0, 3000)}</pre>
    ` : ''}

    ${incident.events ? `
    <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 8px;">Events</h3>
    <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px;">${incident.events}</pre>
    ` : ''}

    <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;">
    <p style="color: #999; font-size: 12px;">Generated by BLUE.Y — AI Ops Assistant<br>Cluster: ${process.env.CLUSTER_NAME || 'my-cluster'} | Transport: ${useSmtp ? 'SMTP' : 'AWS SES'}</p>
  </div>
</div>`;

    return { subject, body };
  }
}
