// SMTP delivery of invitation links (optional; configured in the setup wizard).
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Mailer, SmtpWithPassword } from './service.ts';

export function smtpTransportOptions(smtp: SmtpWithPassword): SMTPTransport.Options {
  const { settings: s, password } = smtp;
  return {
    host: s.host,
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

export function createMailer(smtp: SmtpWithPassword | null): Mailer | null {
  if (!smtp) return null;
  const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
  return {
    async send(msg) {
      await transport.sendMail({ from: smtp.settings.from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
