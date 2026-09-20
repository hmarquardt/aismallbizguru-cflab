import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function clientPath(): string | null {
  const candidates = [
    process.env.TOPHAT_CLIENT_PATH,
    new URL('../../../tophatferals/index.html', import.meta.url).pathname,
  ];
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? null;
}
const path = clientPath();
const html = path ? readFileSync(path, 'utf8') : '';

function extract(name: string): string {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return match[0];
}
const normalizeSighting = path
  ? new Function(`${extract('unwrapLabBoxRecord')}\n${extract('normalizeDate')}\n${extract('normalizeSighting')}; return normalizeSighting;`)() as (record: unknown) => Record<string, unknown> | null
  : null;

test('linked public projection image wins over a stale payload photo_url', { skip: !path }, () => {
  const record = normalizeSighting!({
    id: 'r1',
    data: { cat_name: 'Test', photo_url: '/api/apps/top-hat-ferals/files/stale/content' },
    photos: [{ id: 'f1', url: 'https://cflab.aismallbizguru.com/api/public/top-hat-ferals/files/f1', content_type: 'image/jpeg' }],
  });
  assert.equal(record?.photo_url, 'https://cflab.aismallbizguru.com/api/public/top-hat-ferals/files/f1');
});

test('manual photo_url remains usable when no linked file exists', { skip: !path }, () => {
  const record = normalizeSighting!({ id: 'r2', data: { photo_url: 'https://example.com/manual.jpg' }, photos: [] });
  assert.equal(record?.photo_url, 'https://example.com/manual.jpg');
  const empty = normalizeSighting!({ id: 'r3', data: {} });
  assert.equal(empty?.photo_url, null);
});

test('the origin migration seeds both Top Hat production origins', () => {
  const migration = readFileSync(new URL('../../migrations/0006_top_hat_origins.sql', import.meta.url), 'utf8');
  assert.match(migration, /INSERT OR IGNORE INTO app_origins/);
  assert.ok(migration.includes("'https://tophatferals.com'"));
  assert.ok(migration.includes("'https://www.tophatferals.com'"));
});

test('upload flow no longer patches authenticated download URLs into records', { skip: !path }, () => {
  assert.doesNotMatch(html, /updateRecordPhotoUrl|extractFileUrl/);
  assert.doesNotMatch(html, /photo_url PATCH/);
  assert.equal((html.match(/photos\[0\]\.url/g) ?? []).length, 3);
  assert.match(html, /X-Record-Id/);
  assert.match(html, /X-Resource/);
});
