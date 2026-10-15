// Small, provider-agnostic transactional-email surface. Delivery failures raise
// EmailDeliveryError with a message that is safe to show to an administrator:
// provider response bodies, recipients, and credentials never appear here.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface EmailProvider {
  readonly name: string;
  send(from: { email: string; name: string | null }, message: EmailMessage): Promise<void>;
}
export class EmailDeliveryError extends Error {
  constructor(message = 'Email delivery failed') { super(message); }
}
