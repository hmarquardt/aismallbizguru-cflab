// Server-side source permissions. Changing a database row or request cannot
// enable a restricted provider. Re-enabling one requires a reviewed code change
// with the applicable permission/eligibility evidence in the operations guide.
export const SOURCE_POLICY: Readonly<Record<string, { enabled: boolean; reason: string }>> = {
  okx: { enabled: true, reason: 'Operator-approved private personal market analysis under API section 9.4; documented public endpoints only, no third-party distribution or access bypass.' },
  deribit: { enabled: false, reason: 'Personal-use data exception applies, but US residency is prohibited by Deribit access restrictions; no VPN workaround.' },
  'kraken-futures': { enabled: true, reason: 'Private personal research through expressly documented public automated endpoints; no derivatives account or trading access.' },
  'kraken-spot': { enabled: true, reason: 'Private personal research through documented public market-data API; no third-party distribution.' },
  'coinbase-spot': { enabled: true, reason: 'Personal/internal entity research only; no outside-organization distribution or benchmark use.' },
  'mempool-space': { enabled: true, reason: 'Low-volume use of the published public API; reported network statistics with attribution and no warranty.' },
  'coingecko-treasury': { enabled: true, reason: 'Private noncommercial research with daily refresh and attribution; operator authorized the narrow termination-deletion exception documented in AGENTS.md.' },
  'curated-research': { enabled: true, reason: 'Human-attributed evidence; writers remain responsible for rights to the cited material.' },
};

export function isSourceEnabled(id: string): boolean {
  return Object.hasOwn(SOURCE_POLICY, id) && SOURCE_POLICY[id]!.enabled;
}

// These SQL literals come only from the fixed server-side policy above, never
// from an HTTP parameter, settings row, binding name, or supplied SQL fragment.
const enabledIds = Object.keys(SOURCE_POLICY).filter(isSourceEnabled);
const enabledSql = enabledIds.map(id => `'${id}'`).join(', ');
export const REPORTABLE_OBSERVATIONS_SQL = `source_id IN (${enabledSql})`;

export function reportableAlertsSql(alias: '' | 'a' = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const rule = `${prefix}rule_id`;
  const key = `${prefix}dedupe_key`;
  const sources = enabledIds.filter(id => id !== 'curated-research').map(id => `${key} LIKE '${id}:%'`).join(' OR ') || '0';
  const funding = ['okx', 'deribit', 'kraken-futures'].filter(isSourceEnabled).map(id => `${key} LIKE '${id}:%'`).join(' OR ') || '0';
  return `(${rule} = 'verified-development'
    OR (${rule} = 'stale-source' AND (${sources}))
    OR (${rule} = 'funding-sustained' AND (${funding}))
    OR (${rule} = 'treasury-change' AND ${isSourceEnabled('coingecko-treasury') ? '1' : '0'}))`;
}
