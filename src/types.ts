export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  PROXY_ALLOWED_HOSTS: string;
  PROXY_SECRETS?: string;
}
export interface AppRow {
  id: string; name: string; active: number; config_json: string;
  created_at: string; updated_at: string;
}
export type Scope = 'records:read' | 'records:write' | 'files:read' | 'files:write' | 'proxy:use';
export type ContextEnv = { Bindings: Bindings; Variables: { app: AppRow; scopes: Scope[] } };
