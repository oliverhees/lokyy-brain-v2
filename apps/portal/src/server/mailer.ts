// SMTP delivery of invitation links (optional; configured in the setup wizard).
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Mailer, SmtpWithPassword } from './service.ts';
import { checkSmtpHost, type Resolve } from './smtp-guard.ts';

/** address: the checked IP to connect to; TLS still verifies the configured hostname. */
export function smtpTransportOptions(smtp: SmtpWithPassword, address: string): SMTPTransport.Options {
  const { settings: s, password } = smtp;
  return {
    host: address,
    tls: { servername: s.host },
    port: s.port,
    secure: s.secure,
    // Without implicit TLS insist on STARTTLS: the mail carries a login link.
    requireTLS: !s.secure,
    ...(s.username ? { auth: { user: s.username, pass: password ?? '' } } : {}),
    // Messages are plain text built by the portal; never let nodemailer read files or fetch URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export interface SmtpGuard {
  allowed: readonly string[];
  resolve?: Resolve;
}

export function createMailer(smtp: SmtpWithPassword | null, guard: SmtpGuard): Mailer | null {
  if (!smtp) return null;
  return {
    async send(msg) {
      // checked on every send: the DNS answer may have changed since the admin saved the host
      const check = await checkSmtpHost(smtp.settings.host, guard.allowed, guard.resolve);
      if (!check.ok) throw new Error(`SMTP host ${smtp.settings.host} refused (${check.reason})`);
      const transport = nodemailer.createTransport(smtpTransportOptions(smtp, check.address));
      try {
        await transport.sendMail({ from: smtp.settings.from, to: msg.to, subject: msg.subject, text: msg.text });
      } finally {
        transport.close();
      }
    },
  };
}
