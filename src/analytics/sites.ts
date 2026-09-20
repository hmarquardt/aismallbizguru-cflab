export interface SiteRow {
  id: number;
  public_id: string;
  legacy_key: string | null;
  slug: string;
  name: string;
  timezone: string;
  active: number;
  respect_dnt: number;
  respect_gpc: number;
  raw_retention_days: number;
  created_by_user_id: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DomainRow {
  id: number;
  site_id: number;
  hostname: string;
  kind: 'primary' | 'alias';
  active: number;
  verified_at_ms: number | null;
  created_at_ms: number;
}

// Public tracking IDs and legacy keys are the only accepted collection
// references; slugs are human-readable and intentionally not tracking IDs.
export async function findSiteForCollection(db: D1Database, ref: string): Promise<SiteRow | null> {
  return await db.prepare('SELECT * FROM analytics_sites WHERE public_id = ? OR legacy_key = ? LIMIT 1')
    .bind(ref, ref).first<SiteRow>();
}

export async function findSiteByRef(db: D1Database, ref: string): Promise<SiteRow | null> {
  return await db.prepare('SELECT * FROM analytics_sites WHERE public_id = ? OR legacy_key = ? OR slug = ? LIMIT 1')
    .bind(ref, ref, ref).first<SiteRow>();
}

export async function findActiveDomain(db: D1Database, siteId: number, hostname: string): Promise<DomainRow | null> {
  return await db.prepare('SELECT * FROM analytics_domains WHERE site_id = ? AND hostname = ? AND active = 1 LIMIT 1')
    .bind(siteId, hostname).first<DomainRow>();
}

export async function primaryDomain(db: D1Database, siteId: number): Promise<DomainRow | null> {
  return await db.prepare("SELECT * FROM analytics_domains WHERE site_id = ? AND kind = 'primary' LIMIT 1")
    .bind(siteId).first<DomainRow>();
}

export async function domainsForSite(db: D1Database, siteId: number): Promise<DomainRow[]> {
  const { results } = await db.prepare('SELECT * FROM analytics_domains WHERE site_id = ? ORDER BY kind, hostname')
    .bind(siteId).all<DomainRow>();
  return results;
}

export function siteOutput(site: SiteRow, role?: string) {
  return {
    id: site.id,
    public_id: site.public_id,
    legacy_key: site.legacy_key,
    slug: site.slug,
    name: site.name,
    timezone: site.timezone,
    active: !!site.active,
    respect_dnt: !!site.respect_dnt,
    respect_gpc: !!site.respect_gpc,
    raw_retention_days: site.raw_retention_days,
    created_at_ms: site.created_at_ms,
    updated_at_ms: site.updated_at_ms,
    ...(role ? { role } : {}),
  };
}
