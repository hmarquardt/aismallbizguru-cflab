export interface EmailBinding {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  PROXY_ALLOWED_HOSTS: string;
  PROXY_SECRETS?: string;
  EMAIL?: EmailBinding;
  RL_LOGIN?: RateLimitBinding;
  RL_RECOVERY?: RateLimitBinding;
  RL_RESET?: RateLimitBinding;
  AUTH_FROM_EMAIL?: string;
  AUTH_PUBLIC_BASE_URL?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
  AUTH_RESET_TTL_SECONDS?: string;
}
export interface AppRow {
  id: string; name: string; active: number; config_json: string;
  created_at: string; updated_at: string;
}
export interface UserRow {
  id: string; email: string; password_hash: string | null; active: number; is_admin: number;
  created_at: string; updated_at: string; password_changed_at: string | null; last_login_at: string | null;
}
export interface HumanUser {
  id: string; email: string; active: boolean; is_admin: boolean;
}
export interface Membership {
  app_id: string; access: 'read' | 'write';
}
export type Scope = 'records:read' | 'records:write' | 'files:read' | 'files:write' | 'proxy:use';
export type ContextEnv = { Bindings: Bindings; Variables: { app: AppRow; scopes: Scope[]; user?: HumanUser } };
