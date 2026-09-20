import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function clientPath(): string | null {
  const candidates = [
    process.env.WFR_CLIENT_PATH,
    new URL('../../../junkdrawer/wildlife-field-recorder.html', import.meta.url).pathname,
  ];
  return candidates.find(candidate => candidate && existsSync(candidate)) ?? null;
}
const path = clientPath();
const html = path ? readFileSync(path, 'utf8') : '';
function extract(name: string): string {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(html);
  assert.ok(match, `${name} not found in client`);
  return match[0];
}

test('Field Recorder uses CFLab human sessions with no shared bearer token', { skip: !path }, () => {
  assert.match(html, /cflab\.aismallbizguru\.com/);
  assert.doesNotMatch(html, /(?:^|[^a-z])lab\.aismallbizguru\.com\/api\/(?!analytics)/m);
  assert.doesNotMatch(html, /settings\.token|cfg-token|LabBox bearer/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /SESSION_KEY/);
  assert.match(html, /api\/auth\/login/);
  assert.match(html, /api\/auth\/me/);
  assert.match(html, /api\/auth\/logout/);
});

test('Field Recorder writes use CFLab record routes with idempotent creates and linked files', { skip: !path }, () => {
  assert.match(html, /function recordsUrl\(resource\)/);
  assert.match(html, /function recordUrl\(resource, recordId\)/);
  assert.match(html, /function filesUrl\(\)/);
  assert.match(html, /remoteCreateId/);
  assert.match(html, /'X-File-Id'/);
  assert.match(html, /'X-Record-Id'/);
  assert.match(html, /'X-Resource'/);
  assert.doesNotMatch(html, /new FormData\(\)/);
  assert.doesNotMatch(html, /multipart/);
});

test('Field Recorder reads are fully paginated and cached collections survive failure', { skip: !path }, () => {
  assert.match(html, /next_cursor/);
  assert.match(html, /Malformed pagination cursor/);
  assert.match(html, /Repeated pagination cursor/);
  assert.match(html, /Pagination limit exceeded/);
  assert.match(html, /fetchCompleteCollection/);
  assert.match(html, /fetchRecordFiles/);
  assert.match(html, /pending captures are kept locally/i);
});


test('Field Recorder encodes upload filenames for header safety', { skip: !path }, () => {
  const encodeUploadFilename = new Function(`${extract('encodeUploadFilename')}; return encodeUploadFilename;`)() as (name: string) => string;
  const encoded = encodeUploadFilename('Screenshot 2026-09-20 at 11.38.07 AM.png');
  assert.match(encoded, /^utf8:[\x20-\x7e]*$/);
  assert.equal(decodeURIComponent(encoded.slice(5)), 'Screenshot 2026-09-20 at 11.38.07 AM.png');
  assert.match(html, /encodeUploadFilename\(\(photo\.originalFilename \|\| 'photo'\) \+ ext\)/);
});
