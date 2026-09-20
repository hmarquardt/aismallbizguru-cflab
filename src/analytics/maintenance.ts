import { shiftDay, siteDay } from './sanitize';

interface SiteConfig {
  id: number;
  timezone: string;
  raw_retention_days: number;
}

const ROLLUP_DAYS = 3;
const PURGE_CHUNK = 2000;
const PURGE_MAX_CHUNKS = 10;
const EXPIRED_DAYS_PER_RUN = 10;

// Hourly maintenance: rebuild recent daily rollups, roll up any expired days
// before deleting them, then delete raw events past each Site's retention in
// bounded chunks. If too many expired days accumulated (for example after the
// migration backfill), purge is deferred until all of them are rolled up.
export async function runMaintenance(db: D1Database, nowMs = Date.now()): Promise<{ sites: number; purged: number }> {
  const { results } = await db.prepare('SELECT id, timezone, raw_retention_days FROM analytics_sites WHERE active = 1')
    .all<SiteConfig>();
  let purged = 0;
  for (const site of results) {
    const today = siteDay(site.timezone, nowMs);
    const days = Array.from({ length: ROLLUP_DAYS }, (_, index) => shiftDay(today, index - (ROLLUP_DAYS - 1)));
    await rollup(db, site.id, days);
    const cutoff = shiftDay(today, -site.raw_retention_days);
    const expired = await db.prepare(
      'SELECT DISTINCT site_day FROM analytics_events WHERE site_id = ? AND site_day < ? ORDER BY site_day LIMIT ?')
      .bind(site.id, cutoff, EXPIRED_DAYS_PER_RUN + 1).all<{ site_day: string }>();
    if (expired.results.length > EXPIRED_DAYS_PER_RUN) continue;
    for (const row of expired.results) await rollup(db, site.id, [row.site_day]);
    purged += await purge(db, site.id, cutoff);
  }
  return { sites: results.length, purged };
}

async function rollup(db: D1Database, siteId: number, days: string[]): Promise<void> {
  const placeholders = days.map(() => '?').join(', ');
  const params = [siteId, ...days];
  await db.batch([
    db.prepare(
      `INSERT INTO analytics_daily_site (site_id, site_day, pageviews, events, sessions)
       SELECT site_id, site_day,
              SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END),
              SUM(CASE WHEN event_kind = 'event' THEN 1 ELSE 0 END),
              COUNT(DISTINCT session_id)
       FROM analytics_events WHERE site_id = ? AND site_day IN (${placeholders})
       GROUP BY site_id, site_day
       ON CONFLICT(site_id, site_day) DO UPDATE SET pageviews = excluded.pageviews, events = excluded.events, sessions = excluded.sessions`)
      .bind(...params),
    db.prepare(
      `INSERT INTO analytics_daily_domains (site_id, site_day, domain_id, pageviews, events, sessions)
       SELECT site_id, site_day, domain_id,
              SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END),
              SUM(CASE WHEN event_kind = 'event' THEN 1 ELSE 0 END),
              COUNT(DISTINCT session_id)
       FROM analytics_events WHERE site_id = ? AND site_day IN (${placeholders})
       GROUP BY site_id, site_day, domain_id
       ON CONFLICT(site_id, site_day, domain_id) DO UPDATE SET pageviews = excluded.pageviews, events = excluded.events, sessions = excluded.sessions`)
      .bind(...params),
    db.prepare(
      `INSERT INTO analytics_daily_pages (site_id, site_day, pathname, pageviews, events, sessions)
       SELECT site_id, site_day, pathname,
              SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END),
              SUM(CASE WHEN event_kind = 'event' THEN 1 ELSE 0 END),
              COUNT(DISTINCT session_id)
       FROM analytics_events WHERE site_id = ? AND site_day IN (${placeholders})
       GROUP BY site_id, site_day, pathname
       ON CONFLICT(site_id, site_day, pathname) DO UPDATE SET pageviews = excluded.pageviews, events = excluded.events, sessions = excluded.sessions`)
      .bind(...params),
    db.prepare(
      `INSERT INTO analytics_daily_referrers (site_id, site_day, referrer_host, pageviews, sessions)
       SELECT site_id, site_day, COALESCE(referrer_host, 'direct'),
              SUM(CASE WHEN event_kind = 'pageview' THEN 1 ELSE 0 END),
              COUNT(DISTINCT CASE WHEN event_kind = 'pageview' THEN session_id END)
       FROM analytics_events WHERE site_id = ? AND site_day IN (${placeholders})
       GROUP BY site_id, site_day, referrer_host
       ON CONFLICT(site_id, site_day, referrer_host) DO UPDATE SET pageviews = excluded.pageviews, sessions = excluded.sessions`)
      .bind(...params),
    db.prepare(
      `INSERT INTO analytics_daily_events (site_id, site_day, event_name, count, sessions)
       SELECT site_id, site_day, event_name, COUNT(*), COUNT(DISTINCT session_id)
       FROM analytics_events WHERE site_id = ? AND site_day IN (${placeholders}) AND event_kind = 'event'
       GROUP BY site_id, site_day, event_name
       ON CONFLICT(site_id, site_day, event_name) DO UPDATE SET count = excluded.count, sessions = excluded.sessions`)
      .bind(...params),
  ]);
}

async function purge(db: D1Database, siteId: number, cutoffDay: string): Promise<number> {
  let deleted = 0;
  for (let chunk = 0; chunk < PURGE_MAX_CHUNKS; chunk++) {
    const result = await db.prepare(
      `DELETE FROM analytics_events WHERE id IN (
         SELECT id FROM analytics_events WHERE site_id = ? AND site_day < ? LIMIT ?)`).bind(siteId, cutoffDay, PURGE_CHUNK).run();
    deleted += result.meta.changes;
    if (result.meta.changes < PURGE_CHUNK) break;
  }
  return deleted;
}
