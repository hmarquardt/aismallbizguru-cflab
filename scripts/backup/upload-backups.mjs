#!/usr/bin/env node
// Upload verified D1 backups into the backup bucket.
//
// Runs after scripts/backup/d1-export.mjs and after the isolated restore check, so
// only a backup that has been restored successfully is ever uploaded. Every
// artifact keeps its date-stamped key, and the client refuses to replace an
// existing object, so a re-run can never overwrite a stored backup.
//
// The destination bucket is deliberately constrained: it must not be the
// production file bucket, and this script has no delete path at all.
//
// Environment (never committed):
//   CFLAB_BACKUP_BUCKET      destination bucket, for example cflab-backups
//   CLOUDFLARE_ACCOUNT_ID    account that owns it
//   R2_ACCESS_KEY_ID         R2 S3 access key scoped to the backup bucket
//   R2_SECRET_ACCESS_KEY     matching secret
//
// Usage: node scripts/backup/upload-backups.mjs --dir <backup dir> [--report <file>]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createR2Client } from './r2-client.mjs';
import { validateManifest, verifyArtifactAgainstManifest, writeJsonFile } from './lib.mjs';

// Writing backups into production storage would defeat the point of a backup.
export const FORBIDDEN_DESTINATIONS = new Set(['cflab-files', 'labs-smallbizguru-backups']);

export function r2FromEnvironment(env = process.env, { fetchImpl } = {}) {
  const bucket = env.CFLAB_BACKUP_BUCKET;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const missing = Object.entries({ CFLAB_BACKUP_BUCKET: bucket, CLOUDFLARE_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey })
    .filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing backup configuration: ${missing.join(', ')} (see docs/BACKUP-RESTORE.md)`);
  if (FORBIDDEN_DESTINATIONS.has(bucket)) throw new Error(`refusing to write backups into "${bucket}"; use a dedicated backup bucket`);
  return createR2Client({ accountId, bucket, accessKeyId, secretAccessKey, fetchImpl });
}

export async function uploadBackups({ dir, client = r2FromEnvironment() }) {
  const manifests = readdirSync(dir).filter(name => name.endsWith('.manifest.json')).sort();
  if (!manifests.length) throw new Error(`no manifests found in ${dir}; run d1-export.mjs first`);
  const uploaded = [];
  for (const name of manifests) {
    const manifestPath = path.join(dir, name);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const problems = validateManifest(manifest);
    if (problems.length) throw new Error(`${name} is not a usable manifest:\n- ${problems.join('\n- ')}`);
    const artifactProblems = await verifyArtifactAgainstManifest(manifest, path.join(dir, manifest.file));
    if (artifactProblems.length) throw new Error(`${name}: ${artifactProblems.join('; ')}`);

    // The stored key mirrors the export's date-stamped naming.
    const base = `d1/${manifest.database}/${manifest.captured_at.slice(0, 10)}/${manifest.database}-${manifest.stamp}`;
    const keys = { sql: `${base}.sql`, checksum: `${base}.sql.sha256`, manifest: `${base}.manifest.json` };
    const body = readFileSync(path.join(dir, manifest.file));
    const sql = await client.putObject(keys.sql, body, { contentType: 'application/sql' });
    await client.putObject(keys.checksum, readFileSync(path.join(dir, `${manifest.file}.sha256`)), { contentType: 'text/plain' });
    await client.putObject(keys.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { contentType: 'application/json' });
    uploaded.push({ database: manifest.database, keys, bytes: sql.size, sha256: manifest.sha256 });
    console.log(`OK    ${manifest.database}: uploaded ${keys.sql} (${sql.size} bytes)`);
  }
  return uploaded;
}

async function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex === -1 ? 'backups' : args[dirIndex + 1];
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/backup/upload-backups.mjs --dir <backup dir> [--report <file>]');
    return;
  }
  const uploaded = await uploadBackups({ dir });
  const reportIndex = args.indexOf('--report');
  if (reportIndex !== -1) writeJsonFile(args[reportIndex + 1], { uploaded });
  console.log(`OK    uploaded ${uploaded.length} backup(s) to ${process.env.CFLAB_BACKUP_BUCKET}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
