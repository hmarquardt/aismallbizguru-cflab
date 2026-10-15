import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsBindings } from '../../src/analytics/env';
import { call, testEnv } from './helpers';

// The Analytics Worker must report its own deployment identity so the release
// pipeline can confirm which Git revision is serving production. Only
// non-sensitive release metadata is exposed.
const REVISION = 'f406792bf53cff4c4648b941dcb6c81b66d460f3';

// DEPLOY_REVISION is supplied per release by the pipeline rather than by
// wrangler.jsonc, so it is not part of the committed binding list.
function releaseEnv(revision: string): AnalyticsBindings {
  return Object.assign(testEnv(), { DEPLOY_REVISION: revision });
}

describe('deployment identity', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reports an unknown revision when no release revision is configured', async () => {
    const response = await call('/api/version');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'cflab-analytics', revision: 'unknown' });
  });
  it('reports the release revision supplied by the deployment pipeline', async () => {
    const response = await call('/api/version', {}, releaseEnv(REVISION));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'cflab-analytics', revision: REVISION });
  });
  it('never echoes an unexpected deployment revision value', async () => {
    const response = await call('/api/version', {}, releaseEnv('not a revision!; DROP TABLE sites'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'cflab-analytics', revision: 'unknown' });
  });
});
