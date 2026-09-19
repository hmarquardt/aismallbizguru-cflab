import { createHash } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://lab.aismallbizguru.com';
export const MIGRATION_SOURCE = 'labbox-live-api';
export const DEFAULT_DATASETS: ReadonlyArray<{ app: string; resource: string }> = [
  { app: 'wildlife-field-recorder', resource: 'observations' },
  { app: 'wildlife-field-recorder', resource: 'trips' },
  { app: 'top-hat-ferals', resource: 'sightings' },
  { app: 'top-hat-ferals', resource: 'cats' },
  { app: 'top-hat-ferals', resource: 'interactions' },
];
export const DEFAULT_APP_MAP: Record<string, { name: string; origins: string[] }> = {
  'wildlife-field-recorder': { name: 'Wildlife Field Recorder', origins: ['https://hmarquardt.github.io'] },
  'top-hat-ferals': { name: 'Top Hat Ferals', origins: ['https://hmarquardt.github.io'] },
};

export interface LegacyFile {
  id: string; app_id: string; resource?: string | null; record_id?: string | null;
  filename: string; content_type?: string | null; size_bytes?: number | null; checksum?: string | null;
  created_at: string; url?: string | null; download_url?: string | null;
}
export interface LegacyRecord {
  id: string; app_id: string; resource: string; data: Record<string, unknown>;
  created_at: string; updated_at: string; deleted_at?: string | null; files?: LegacyFile[];
}
export interface SnapshotManifest {
  snapshot_id: string; source: string; base_url: string; started_at: string; completed_at: string;
  datasets: Array<{ app: string; resource: string; total: number | null; exported: number; complete: boolean }>;
  files: { referenced: number; downloaded: number; bytes: number; missing: string[]; complete: boolean };
  rejected_records: number;
  app_map: Record<string, { name: string; origins: string[] }>;
}
export interface Snapshot { manifest: SnapshotManifest; records: LegacyRecord[]; files: LegacyFile[] }

export function assertGetOnly(method: string): void {
  if (method.toUpperCase() !== 'GET') throw new Error(`refusing non-GET request: ${method}`);
}
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch { return raw.split('?')[0]!.split('#')[0]!; }
}
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
export function recordKey(record: { app_id: string; resource: string; id: string }): string {
  return `${record.app_id}/${record.resource}/${record.id}`;
}
export function cflabObjectKey(appId: string, fileId: string): string {
  return `apps/${appId}/files/${fileId}`;
}
export function cflabContentUrl(appId: string, fileId: string): string {
  return `/api/apps/${appId}/files/${fileId}/content`;
}

export function validateRecord(raw: unknown): string[] {
  const problems: string[] = [];
  const record = raw as Partial<LegacyRecord> | null;
  if (!record || typeof record !== 'object') return ['not an object'];
  if (typeof record.id !== 'string' || !record.id) problems.push('missing id');
  if (typeof record.app_id !== 'string' || !record.app_id) problems.push('missing app_id');
  if (typeof record.resource !== 'string' || !record.resource) problems.push('missing resource');
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) problems.push('data is not an object');
  if (typeof record.created_at !== 'string' || !record.created_at) problems.push('missing created_at');
  if (typeof record.updated_at !== 'string' || !record.updated_at) problems.push('missing updated_at');
  return problems;
}
export function validateFile(raw: unknown): string[] {
  const problems: string[] = [];
  const file = raw as Partial<LegacyFile> | null;
  if (!file || typeof file !== 'object') return ['not an object'];
  if (typeof file.id !== 'string' || !file.id) problems.push('missing id');
  if (typeof file.app_id !== 'string' || !file.app_id) problems.push('missing app_id');
  if (typeof file.filename !== 'string' || !file.filename) problems.push('missing filename');
  if (typeof file.created_at !== 'string' || !file.created_at) problems.push('missing created_at');
  if (file.size_bytes != null && (typeof file.size_bytes !== 'number' || file.size_bytes < 0)) problems.push('invalid size_bytes');
  return problems;
}

// Rewrites legacy LabBox file URLs inside record payloads to CFLab's own content route.
// Only URLs that map to a known migrated file are rewritten; everything else is preserved.
const FILE_URL = /^(?:https?:\/\/[^/]+)?\/api\/files\/([0-9a-fA-F-]{36})$/;
export function rewriteLegacyFileUrls(data: Record<string, unknown>, appId: string, knownFileIds: Set<string>): { data: Record<string, unknown>; changed: string[] } {
  const changed: string[] = [];
  const output: Record<string, unknown> = { ...data };
  for (const field of ['photo_url', 'photo', 'image']) {
    const value = output[field];
    if (typeof value !== 'string') continue;
    const match = FILE_URL.exec(value);
    if (!match?.[1] || !knownFileIds.has(match[1])) continue;
    output[field] = cflabContentUrl(appId, match[1]);
    changed.push(field);
  }
  return { data: output, changed };
}
export function verifyFileBytes(bytes: Uint8Array, meta: { size_bytes?: number | null; checksum?: string | null }): { ok: boolean; sha256: string; sizeOk: boolean; checksumOk: boolean | null } {
  const sha256 = sha256Hex(bytes);
  const sizeOk = meta.size_bytes == null || meta.size_bytes === bytes.length;
  const checksumOk = meta.checksum ? meta.checksum === sha256 : null;
  return { ok: sizeOk && checksumOk !== false, sha256, sizeOk, checksumOk };
}

// Complete-collection pagination. Legacy list endpoints return everything plus a total;
// the loop also supports cursor endpoints and refuses partial, capped, or repeated pages.
export async function collectComplete<T>(
  label: string,
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; total?: number; next?: string | null }>,
  maxPages = 1000,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    const next = page.next ?? null;
    if (next === null) {
      if (page.total !== undefined && page.total !== items.length) {
        throw new Error(`${label}: incomplete collection (total ${page.total}, received ${items.length})`);
      }
      return { items, pages };
    }
    if (seen.has(next)) throw new Error(`${label}: repeated pagination cursor`);
    seen.add(next);
    cursor = next;
  }
  throw new Error(`${label}: exceeded ${maxPages} pages`);
}

export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
export function appInsertSql(id: string, name: string, origins: string[]): string[] {
  const now = new Date().toISOString();
  return [
    `INSERT INTO apps (id, name, active, config_json, created_at, updated_at) VALUES (${sqlValue(id)}, ${sqlValue(name)}, 1, '{}', ${sqlValue(now)}, ${sqlValue(now)});`,
    ...origins.map(origin => `INSERT INTO app_origins (app_id, origin) VALUES (${sqlValue(id)}, ${sqlValue(origin)});`),
  ];
}
export function recordInsertSql(record: LegacyRecord, dataJson: string): string {
  return `INSERT INTO records (id, app_id, resource, data_json, status, created_at, updated_at) VALUES (${sqlValue(record.id)}, ${sqlValue(record.app_id)}, ${sqlValue(record.resource)}, ${sqlValue(dataJson)}, NULL, ${sqlValue(record.created_at)}, ${sqlValue(record.updated_at)});`;
}
export function fileInsertSql(file: LegacyFile): string {
  return `INSERT INTO files (id, app_id, object_key, filename, content_type, size_bytes, checksum, created_at, resource, record_id) VALUES (${sqlValue(file.id)}, ${sqlValue(file.app_id)}, ${sqlValue(cflabObjectKey(file.app_id, file.id))}, ${sqlValue(file.filename)}, ${sqlValue(file.content_type ?? 'application/octet-stream')}, ${sqlValue(file.size_bytes ?? 0)}, ${sqlValue(file.checksum ?? null)}, ${sqlValue(file.created_at)}, ${sqlValue(file.resource ?? null)}, ${sqlValue(file.record_id ?? null)});`;
}

export interface ExistingState {
  apps: Map<string, { name: string; active: boolean; origins: Set<string> }>;
  records: Map<string, { data_json: string; created_at: string; updated_at: string }>;
  files: Map<string, { size_bytes: number; checksum: string | null }>;
}
export interface ImportPlan {
  appsToCreate: Array<{ id: string; name: string; origins: string[] }>;
  appConflicts: Array<{ id: string; reason: string }>;
  records: {
    insert: Array<{ record: LegacyRecord; dataJson: string }>;
    present: string[];
    conflicts: Array<{ key: string; reason: string }>;
    malformed: Array<{ key: string; problems: string[] }>;
  };
  files: {
    insert: LegacyFile[];
    present: string[];
    conflicts: Array<{ id: string; reason: string }>;
    malformed: Array<{ id: string; problems: string[] }>;
    orphans: string[];
  };
  transforms: Array<{ key: string; fields: string[] }>;
  bytesToCopy: number;
}
export function buildImportPlan(snapshot: Snapshot, existing: ExistingState, update = false): ImportPlan {
  const plan: ImportPlan = {
    appsToCreate: [], appConflicts: [],
    records: { insert: [], present: [], conflicts: [], malformed: [] },
    files: { insert: [], present: [], conflicts: [], malformed: [], orphans: [] },
    transforms: [], bytesToCopy: 0,
  };
  const usedApps = new Set(snapshot.records.map(record => record.app_id).concat(snapshot.files.map(file => file.app_id)));
  for (const appId of [...usedApps].sort()) {
    const mapped = snapshot.manifest.app_map[appId] ?? DEFAULT_APP_MAP[appId];
    if (!mapped) { plan.appConflicts.push({ id: appId, reason: 'no app mapping' }); continue; }
    const current = existing.apps.get(appId);
    if (!current) plan.appsToCreate.push({ id: appId, name: mapped.name, origins: mapped.origins });
    else {
      const missing = mapped.origins.filter(origin => !current.origins.has(origin));
      if (missing.length) plan.appConflicts.push({ id: appId, reason: `existing app missing origins: ${missing.join(', ')}` });
    }
  }
  const knownFileIds = new Set(snapshot.files.map(file => file.id));
  for (const record of [...snapshot.records].sort((a, b) => recordKey(a).localeCompare(recordKey(b)))) {
    const key = recordKey(record);
    const problems = validateRecord(record);
    if (problems.length) { plan.records.malformed.push({ key, problems }); continue; }
    const rewritten = rewriteLegacyFileUrls(record.data, record.app_id, knownFileIds);
    if (rewritten.changed.length) plan.transforms.push({ key, fields: rewritten.changed });
    const dataJson = canonicalJson(rewritten.data);
    const current = existing.records.get(key);
    if (!current) { plan.records.insert.push({ record, dataJson }); continue; }
    const identical = canonicalJson(JSON.parse(current.data_json)) === dataJson
      && current.created_at === record.created_at && current.updated_at === record.updated_at;
    if (identical) { plan.records.present.push(key); continue; }
    if (update) plan.records.insert.push({ record, dataJson });
    else plan.records.conflicts.push({ key, reason: 'destination differs' });
  }
  const recordKeys = new Set(snapshot.records.map(recordKey));
  for (const file of [...snapshot.files].sort((a, b) => a.id.localeCompare(b.id))) {
    const problems = validateFile(file);
    if (problems.length) { plan.files.malformed.push({ id: file.id, problems }); continue; }
    if (file.record_id && !recordKeys.has(`${file.app_id}/${file.resource ?? ''}/${file.record_id}`)) {
      const resourceMatch = snapshot.records.some(record => record.id === file.record_id && record.app_id === file.app_id);
      if (!resourceMatch) plan.files.orphans.push(file.id);
    }
    const current = existing.files.get(file.id);
    if (!current) { plan.files.insert.push(file); plan.bytesToCopy += file.size_bytes ?? 0; continue; }
    const identical = current.size_bytes === (file.size_bytes ?? 0) && (file.checksum == null || current.checksum === file.checksum);
    if (identical) { plan.files.present.push(file.id); continue; }
    if (update) { plan.files.insert.push(file); plan.bytesToCopy += file.size_bytes ?? 0; }
    else plan.files.conflicts.push({ id: file.id, reason: 'destination differs' });
  }
  return plan;
}

export interface DeltaReport {
  records: { added: number; changed: number; disappeared: number; unchanged: number };
  files: { added: number; changed: number; disappeared: number; unchanged: number };
}
export function diffSnapshots(previous: Snapshot, next: Snapshot): DeltaReport {
  const report: DeltaReport = {
    records: { added: 0, changed: 0, disappeared: 0, unchanged: 0 },
    files: { added: 0, changed: 0, disappeared: 0, unchanged: 0 },
  };
  const prevRecords = new Map(previous.records.map(record => [recordKey(record), record]));
  const nextRecords = new Map(next.records.map(record => [recordKey(record), record]));
  for (const [key, record] of nextRecords) {
    const prior = prevRecords.get(key);
    if (!prior) report.records.added++;
    else if (prior.updated_at !== record.updated_at || canonicalJson(prior.data) !== canonicalJson(record.data)) report.records.changed++;
    else report.records.unchanged++;
  }
  for (const key of prevRecords.keys()) if (!nextRecords.has(key)) report.records.disappeared++;
  const prevFiles = new Map(previous.files.map(file => [file.id, file]));
  const nextFiles = new Map(next.files.map(file => [file.id, file]));
  for (const [id, file] of nextFiles) {
    const prior = prevFiles.get(id);
    if (!prior) report.files.added++;
    else if (prior.checksum !== file.checksum || prior.size_bytes !== file.size_bytes) report.files.changed++;
    else report.files.unchanged++;
  }
  for (const id of prevFiles.keys()) if (!nextFiles.has(id)) report.files.disappeared++;
  return report;
}
