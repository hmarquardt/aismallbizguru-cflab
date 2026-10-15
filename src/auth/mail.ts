import type { Bindings } from '../types';
import { ApiError } from '../http';
import { sendTransactionalEmail } from './email';
import { inviteTtlSeconds, resetTtlSeconds, type SetupPurpose } from './human';

// Links are always built from the trusted AUTH_PUBLIC_BASE_URL var, never from an
// incoming Host header, and always use HTTPS (loopback HTTP is allowed locally).
export function resetUrl(env: Bindings, token: string): string {
  const base = env.AUTH_PUBLIC_BASE_URL?.trim();
  let url: URL;
  try { url = new URL(base ?? ''); } catch { throw new ApiError(503, 'email_unavailable', 'Password reset links are not configured'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ApiError(503, 'email_unavailable', 'Password reset links must use HTTPS');
  }
  if (url.search || url.hash) throw new ApiError(503, 'email_unavailable', 'Password reset base URL must not contain a query or fragment');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

export interface AuthEmail {
  subject: string;
  text: string;
  html: string;
}

function ttlLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
function layout(heading: string, intro: string, action: string, url: string, outro: string): string {
  return [
    '<!DOCTYPE html><html lang="en"><body style="margin:0;background:#f6f7f9;padding:24px;'
      + 'font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1f2933">',
    '<main style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;padding:28px">',
    '<p style="margin:0 0 20px;font-size:16px;font-weight:700">CFLab</p>',
    `<h1 style="margin:0 0 12px;font-size:19px">${escapeHtml(heading)}</h1>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>`,
    `<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;'
      + 'text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;font-weight:600">${escapeHtml(action)}</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#5f6b7a">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#5f6b7a">${escapeHtml(outro)}</p>`,
    '</main></body></html>',
  ].join('');
}

// Invitations ask a new (passwordless) account to choose its first password.
export function invitationEmail(env: Bindings, url: string): AuthEmail {
  const validity = ttlLabel(inviteTtlSeconds(env));
  return {
    subject: 'Set up your CFLab account',
    text: `An administrator created a CFLab account for you.\n\n`
      + `Choose your password with this single-use link (valid for ${validity}):\n${url}\n\n`
      + `If you did not expect this message, you can ignore it.\n`,
    html: layout('Set up your CFLab account',
      `An administrator created a CFLab account for you. Choose your password using the link below. It is valid for ${validity} and can be used once.`,
      'Choose your password', url,
      'If you did not expect this message, you can ignore it.'),
  };
}

// Recovery resets an existing password and never reveals whether an account exists.
export function passwordResetEmail(env: Bindings, url: string): AuthEmail {
  const validity = ttlLabel(resetTtlSeconds(env));
  return {
    subject: 'Reset your CFLab password',
    text: `A password reset was requested for your CFLab account.\n\n`
      + `Use this single-use link within ${validity}:\n${url}\n\n`
      + `If you did not request this, ignore this message and your password will stay the same.\n`,
    html: layout('Reset your CFLab password',
      `A password reset was requested for your CFLab account. Use the link below to choose a new password. It is valid for ${validity} and can be used once.`,
      'Choose a new password', url,
      'If you did not request this, ignore this message and your password will stay the same.'),
  };
}

export function setupEmail(env: Bindings, purpose: SetupPurpose, url: string): AuthEmail {
  return purpose === 'invite' ? invitationEmail(env, url) : passwordResetEmail(env, url);
}

export async function sendAuthMail(env: Bindings, to: string, email: AuthEmail): Promise<void> {
  await sendTransactionalEmail(env, { to, subject: email.subject, text: email.text, html: email.html });
}

