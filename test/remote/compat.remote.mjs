import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { collectionPath, fixtureToken, getJson, healthy, legacyHealthEnabled, readCollection, recordPath, target } from './probes.mjs';

// Deliberately no default hosts: neither npm test nor CI contacts deployed services.
const targets = {
  labbox: target(process.env.LABBOX_BASE_URL, 'LABBOX_BASE_URL'),
  cflab: target(process.env.CFLAB_BASE_URL, 'CFLAB_BASE_URL'),
};
assert.notEqual(targets.labbox, targets.cflab, 'Parallel checks need distinct origins');
const tokens = { labbox: process.env.LABBOX_READ_TOKEN, cflab: process.env.CFLAB_READ_TOKEN };
const labboxHealth = legacyHealthEnabled(process.env.COMPAT_LABBOX_HEALTH);
const browserOrigin = process.env.COMPAT_ORIGIN ? target(process.env.COMPAT_ORIGIN, 'COMPAT_ORIGIN') : undefined;
const fixtures = process.env.COMPAT_FIXTURES
  ? JSON.parse(await readFile(process.env.COMPAT_FIXTURES, 'utf8')) : [];
const collections = process.env.COMPAT_COLLECTIONS
  ? JSON.parse(await readFile(process.env.COMPAT_COLLECTIONS, 'utf8')) : [];
assert.ok(Array.isArray(fixtures) && fixtures.length <= 20, 'Expected at most 20 fixture pairs');
assert.ok(Array.isArray(collections) && collections.length <= 20, 'Expected at most 20 collection pairs');
// Validate the entire fixture file before making any network requests.
for (const [pairs, path] of [[fixtures, recordPath], [collections, collectionPath]]) {
  for (const fixture of pairs) {
    for (const service of ['labbox', 'cflab']) {
      path(service, fixture?.[service]);
      fixtureToken(fixture[service], tokens[service]);
    }
  }
}

for (const service of ['labbox', 'cflab']) {
  test(`${service}: health identifies the expected service`, {
    skip: service === 'labbox' && !labboxHealth && 'Confirm legacy storage health is disabled, then set COMPAT_LABBOX_HEALTH=1',
  }, async () => {
    const body = await getJson(targets[service], '/api/health');
    assert.ok(healthy(service, body), `${service} health contract mismatch`);
  });
}
test('paired record data (existing fixtures only)', { skip: !fixtures.length && 'Set COMPAT_FIXTURES to enable record comparison' }, async () => {
  for (const [index, fixture] of fixtures.entries()) {
    const rows = {};
    for (const service of ['labbox', 'cflab']) {
      const expected = fixture[service];
      rows[service] = await getJson(targets[service], recordPath(service, expected), fixtureToken(expected, tokens[service]), fetch, browserOrigin);
      const row = rows[service];
      assert.ok(row?.id === expected.id && row.app_id === expected.app && row.resource === expected.resource,
        `${service} fixture ${index + 1}: identity mismatch`);
      assert.ok(row.data && typeof row.data === 'object' && !Array.isArray(row.data), 'Expected record data object');
    }
    // Compare data only: metadata, file links, and delete semantics differ today.
    // A boolean assertion keeps private payloads out of test failure output.
    assert.ok(isDeepStrictEqual(rows.labbox.data, rows.cflab.data), `Fixture ${index + 1}: record data differs`);
  }
});
test('paired complete collections (preserved IDs, existing data only)', {
  skip: !collections.length && 'Set COMPAT_COLLECTIONS to enable paginated collection comparison',
}, async () => {
  for (const [index, fixture] of collections.entries()) {
    const rows = {};
    for (const service of ['labbox', 'cflab']) {
      rows[service] = await readCollection(service, fixture[service], path =>
        getJson(targets[service], path, fixtureToken(fixture[service], tokens[service]), fetch, browserOrigin));
    }
    assert.ok(isDeepStrictEqual(rows.labbox, rows.cflab), `Collection ${index + 1}: IDs or data differ`);
  }
});
