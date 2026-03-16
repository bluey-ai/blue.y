import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

const FROM_ADDRESS = process.env.EMAIL_FROM || 'noreply@example.com';

// Auto-detect transport: SMTP if SMTP_HOST is set, otherwise SES
const useSmtp = !!process.env.SMTP_HOST;

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
