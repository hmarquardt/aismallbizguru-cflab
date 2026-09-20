import { ApiError } from '../http';
import type { AnalyticsBindings, SiteRole, VerifiedHuman } from './env';

const HUMAN_TOKEN_PATTERN = /^cflu_[0-9a-f]{64}$/;
const ROLE_ORDER: Record<SiteRole, number> = { viewer: 1, editor: 2, owner: 3 };

// CFLab is the only identity authority. Analytics never stores users,
// passwords, or sessions; it validates bearer sessions through the narrow
// CFLAB service-binding RPC and receives only { userId, isAdmin }.
export async function authenticate(env: AnalyticsBindings, authorization: string | undefined): Promise<VerifiedHuman> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token || !HUMAN_TOKEN_PATTERN.test(token)) throw new ApiError(401, 'unauthorized', 'Invalid or expired session');
  if (!env.CFLAB) throw new ApiError(503, 'auth_unavailable', 'Authentication service unavailable');
  let verified: VerifiedHuman | null;
  try {
    verified = await env.CFLAB.verifyHumanSession(token);
  } catch {
    throw new ApiError(503, 'auth_unavailable', 'Authentication service unavailable');
  }
  if (!verified?.userId) throw new ApiError(401, 'unauthorized', 'Invalid or expired session');
  return verified;
}

export async function siteRole(db: D1Database, siteId: number, identity: VerifiedHuman): Promise<SiteRole | null> {
  if (identity.isAdmin) return 'owner';
  const row = await db.prepare('SELECT role FROM analytics_site_memberships WHERE site_id = ? AND user_id = ?')
    .bind(siteId, identity.userId).first<{ role: SiteRole }>();
  return row?.role ?? null;
}

export function requireRole(role: SiteRole | null, minimum: SiteRole): void {
  if (!role || ROLE_ORDER[role] < ROLE_ORDER[minimum]) throw new ApiError(403, 'forbidden', 'Insufficient site access');
}
