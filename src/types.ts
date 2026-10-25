// Cloudflare Email Service (Email Sending) `send_email` binding.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
// Returns { messageId }. Failures are thrown as Error objects carrying a stable
// `code` (for example E_RECIPIENT_SUPPRESSED); we log the code and surface only a
// sanitized message, so provider internals never reach an administrator.
export interface EmailAddress { email: string; name?: string; }
export interface EmailMessageBuilder {
  to: string | EmailAddress | (string | EmailAddress)[];
  from: string | EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | EmailAddress;
  cc?: string | EmailAddress | (string | EmailAddress)[];
  bcc?: string | EmailAddress | (string | EmailAddress)[];
  headers?: Record<string, string>;
}
export interface EmailSendResult { messageId: string; }
export interface EmailBinding {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export interface Bindings {
  DB: D1Database;
  ANALYTICS: D1Database;
  BTC_SIGNALS: D1Database;
  FILES: R2Bucket;
  PROXY_ALLOWED_HOSTS: string;
  PROXY_SECRETS?: string;
  DEPLOY_REVISION?: string;
  EMAIL?: EmailBinding;
  RL_LOGIN?: RateLimitBinding;
  RL_RECOVERY?: RateLimitBinding;
  RL_RESET?: RateLimitBinding;
  RL_INVITE?: RateLimitBinding;
  RL_ANALYTICS?: RateLimitBinding;
  AUTH_FROM_EMAIL?: string;
  AUTH_FROM_NAME?: string;
  AUTH_PUBLIC_BASE_URL?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
  AUTH_RESET_TTL_SECONDS?: string;
  AUTH_INVITE_TTL_SECONDS?: string;
}

export interface AppRow {
  id: string; name: string; active: number; config_json: string;
  created_at: string; updated_at: string;
}
export interface UserRow {
  id: string; email: string; password_hash: string | null; active: number; is_admin: number;
  created_at: string; updated_at: string; password_changed_at: string | null; last_login_at: string | null;
  invited_at: string | null; invite_status: 'sent' | 'failed' | null;
  invite_expires_at: string | null; invite_error: string | null;
}
export interface HumanUser {
  id: string; email: string; active: boolean; is_admin: boolean;
}
export interface Membership {
  app_id: string; access: 'read' | 'write';
}
export type Scope = 'records:read' | 'records:write' | 'files:read' | 'files:write' | 'proxy:use';
export type ContextEnv = { Bindings: Bindings; Variables: { app: AppRow; scopes: Scope[]; user?: HumanUser; projectAccess?: 'read' | 'write' } };
