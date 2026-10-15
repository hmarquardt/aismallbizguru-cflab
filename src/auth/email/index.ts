import type { Bindings } from '../../types';
import { ApiError } from '../../http';
import { cloudflareProvider } from './cloudflare';
import { EmailDeliveryError, type EmailMessage, type EmailProvider } from './types';

export type { EmailMessage } from './types';

// A display name is only sent to providers that accept it. The address itself is
// validated so a malformed sender value cannot inject headers.
function senderAddress(value: string | undefined): string {
  const from = value?.trim() ?? '';
  if (!from || from.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(from) || /[\x00-\x1f\x7f]/.test(from)) {
    throw new ApiError(503, 'email_unavailable', 'Email delivery is not configured');
  }
  return from;
}
function senderName(value: string | undefined): string | null {
  const name = value?.trim() ?? '';
  if (!name || name.length > 128 || /[\x00-\x1f\x7f<>]/.test(name)) return null;
  return name;
}

// Cloudflare Email Service (Email Sending) is the only provider: the Worker's
// `send_email` binding. A sender on an onboarded sending domain may send to any
// recipient. Without the binding, mail fails closed.
export function emailProvider(env: Bindings): EmailProvider | null {
  return env.EMAIL ? cloudflareProvider(env.EMAIL) : null;
}

// Delivers one transactional message. Callers get a stable 503 email_unavailable
// ApiError for both "not configured" and "provider rejected/failed" so public
// endpoints never reveal delivery internals.
export async function sendTransactionalEmail(env: Bindings, message: EmailMessage): Promise<void> {
  const address = senderAddress(env.AUTH_FROM_EMAIL);
  const provider = emailProvider(env);
  if (!provider) throw new ApiError(503, 'email_unavailable', 'Email delivery is not configured');
  try {
    await provider.send({ email: address, name: senderName(env.AUTH_FROM_NAME) }, message);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof EmailDeliveryError) throw new ApiError(503, 'email_unavailable', error.message);
    throw new ApiError(503, 'email_unavailable', 'Email delivery failed');
  }
}
