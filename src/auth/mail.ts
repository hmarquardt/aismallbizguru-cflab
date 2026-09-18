import type { Bindings } from '../types';
import { ApiError } from '../http';

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
export async function sendAuthMail(env: Bindings, to: string, subject: string, text: string): Promise<void> {
  const from = env.AUTH_FROM_EMAIL?.trim();
  if (!from || !env.EMAIL) throw new ApiError(503, 'email_unavailable', 'Email delivery is not configured');
  try {
    await env.EMAIL.send({ from, to, subject, text });
  } catch {
    throw new ApiError(503, 'email_unavailable', 'Email delivery failed');
  }
}
