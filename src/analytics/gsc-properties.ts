// The authoritative Google Search Console property list for CFLab Analytics.
//
// These six Domain properties were verified on 2026-10-27 with the existing
// service account (`siteRestrictedUser` on every one). The list is deliberately
// a reviewed constant rather than a discovery result: a request must never be
// able to widen what CFLab reads, and a newly accessible Google property must
// not appear in the dashboard until someone maps it here.
//
// `siteSlug` is the explicit link to a CFLab Analytics Site (`analytics_sites
// .slug`). Two properties have no Site yet:
//
// Every property is linked to a Site. Two were provisioned later than the rest
// (2026-10-27, Road Naturalist and Hank Marquardt), which is why the mapping is
// separate from the Site rows: a property collected before its Site existed keeps
// its retained history and is linked by the next collection run.
//
// Their Search Console data is collected, retained and observable even when a Site
// has no first-party tracking. Setting `siteSlug` explicitly is the only way to
// add a property, and a slug that does not exist is reported as `unresolved` by
// `GET /api/gsc/status` rather than silently hidden.

export interface GscPropertyDefinition {
  /** Google's property identifier: `sc-domain:example.com` or a URL prefix. */
  property: string;
  /** Human-readable label shown in the dashboard and diagnostics. */
  label: string;
  /** CFLab Analytics Site slug, or null while no Site is registered. */
  siteSlug: string | null;
}

export const GSC_PROPERTIES: readonly GscPropertyDefinition[] = [
  { property: 'sc-domain:aismallbizguru.com', label: 'AI Small Business Guru', siteSlug: 'aismallbizguru' },
  { property: 'sc-domain:roadnaturalist.com', label: 'Road Naturalist', siteSlug: 'roadnaturalist' },
  { property: 'sc-domain:hankmarquardt.com', label: 'Hank Marquardt', siteSlug: 'hankmarquardt' },
  { property: 'sc-domain:turkeyvulturesoftware.com', label: 'Turkey Vulture Software', siteSlug: 'turkeyvulturesoftware' },
  { property: 'sc-domain:worthlookingup.com', label: 'Worth Looking Up', siteSlug: 'worthlookingup' },
  { property: 'sc-domain:fruitingforecast.com', label: 'Fruiting Forecast', siteSlug: 'fruiting-forecast' },
] as const;

/** Search Console search type collected. Only web search is requested. */
export const GSC_SEARCH_TYPE = 'web';

const DOMAIN_PREFIX = 'sc-domain:';
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type PropertyKind = 'domain' | 'url_prefix';

// Normalizes a property identifier to the two forms the Search Console API
// accepts, or returns null. Nothing here trusts a caller: the collector only
// ever uses identifiers from GSC_PROPERTIES.
export function parseProperty(property: unknown): { property: string; kind: PropertyKind; hostname: string } | null {
  if (typeof property !== 'string' || property.length > 200) return null;
  if (property.startsWith(DOMAIN_PREFIX)) {
    const host = property.slice(DOMAIN_PREFIX.length).trim().toLowerCase();
    if (!HOSTNAME_PATTERN.test(host)) return null;
    return { property: `${DOMAIN_PREFIX}${host}`, kind: 'domain', hostname: host };
  }
  if (!property.startsWith('https://') && !property.startsWith('http://')) return null;
  try {
    const url = new URL(property);
    const host = url.hostname.toLowerCase();
    if (!HOSTNAME_PATTERN.test(host) || url.pathname !== '/' || url.search || url.hash) return null;
    return { property, kind: 'url_prefix', hostname: host };
  } catch {
    return null;
  }
}

export function knownProperty(property: string): GscPropertyDefinition | null {
  return GSC_PROPERTIES.find(entry => entry.property === property) ?? null;
}

/** Sites that should expose Search Console data. */
export function mappedSiteSlugs(): string[] {
  return GSC_PROPERTIES.flatMap(entry => (entry.siteSlug ? [entry.siteSlug] : []));
}

export function definitionsForSiteSlug(slug: string): GscPropertyDefinition[] {
  return GSC_PROPERTIES.filter(entry => entry.siteSlug === slug);
}
