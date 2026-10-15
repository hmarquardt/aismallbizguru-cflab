import type { EmailBinding } from '../../types';
import { EmailDeliveryError, type EmailProvider } from './types';

// Cloudflare Email Service (Email Sending) through the Worker `send_email`
// binding. Once a sending domain is onboarded to Email Service, the binding can
// send to any recipient; the sender must belong to an onboarded domain.
// `send()` returns { messageId } and throws an Error carrying a stable `code`
// (for example E_RECIPIENT_SUPPRESSED). The code is logged for operators and is
// never included in a message shown to an administrator.
export function cloudflareProvider(binding: EmailBinding): EmailProvider {
  return {
    name: 'cloudflare-email-sending',
    async send(from, message) {
      try {
        await binding.send({
          from: from.name ? { email: from.email, name: from.name } : from.email,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        // Structured, PII-free diagnostic: never the recipient, subject, or body.
        console.error(JSON.stringify({
          event: 'email',
          provider: 'cloudflare-email-sending',
          result: 'rejected',
          ...(typeof code === 'string' ? { code } : {}),
        }));
        throw new EmailDeliveryError('Email delivery failed');
      }
    },
  };
}
