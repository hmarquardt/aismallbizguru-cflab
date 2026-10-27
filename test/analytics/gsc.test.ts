import { describe, expect, it } from 'vitest';
import { app } from '../../src/analytics/index';
import type { AnalyticsBindings } from '../../src/analytics/env';

const auth = 'Bearer cflu_' + 'a'.repeat(64);
function env(isAdmin: boolean, secret?: string): AnalyticsBindings {
  return {
    ANALYTICS: {} as D1Database,
    CFLAB: { verifyHumanSession: async () => ({ userId: 'operator', isAdmin }) },
    ...(secret === undefined ? {} : { GSC_SERVICE_ACCOUNT_JSON: secret }),
  };
}

describe('Search Console properties connectivity endpoint', () => {
  it('rejects unauthenticated requests without exposing configuration', async () => {
    const response = await app.request('/api/gsc/properties', {}, env(true, 'credential'));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('credential');
  });

  it('rejects authenticated non-administrators', async () => {
    const response = await app.request('/api/gsc/properties', {
      headers: { Authorization: auth },
    }, env(false, 'credential'));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('credential');
  });

  it('returns an explicit missing-secret status only to administrators', async () => {
    const response = await app.request('/api/gsc/properties', {
      headers: { Authorization: auth },
    }, env(true));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_configured' });
  });

  it('does not disclose invalid credential material in an error', async () => {
    const response = await app.request('/api/gsc/properties', {
      headers: { Authorization: auth },
    }, env(true, 'malformed-private-credential'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: 'error', code: 'gsc_connection_failed' });
  });
});
