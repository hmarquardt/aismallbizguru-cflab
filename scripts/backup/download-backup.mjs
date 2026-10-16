#!/usr/bin/env node
// Download a stored D1 backup so it can be restored.
//
// Reads the newest manifest for a database from the backup bucket (or a specific
// stamp/key), downloads the SQL artifact, and verifies its size and SHA-256
// against the manifest before writing it locally. Read-only against the backup
// bucket; it never touches a database.
//
// Usage:
//   node scripts/backup/download-backup.mjs --database cflab --out <dir>
//   node scripts/backup/download-backup.mjs --database cflab --out <dir> --stamp 20261016T031500Z

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createR2Client } from './r2-client.mjs';
import { r2FromEnvironment } from './upload-backups.mjs';
import { sha256Bytes, validateManifest } from './lib.mjs';

export async function downloadBackup({ database, outDir, stamp, client = r2FromEnvironment() }) {
  const objects = await client.listObjects({ prefix: `d1/${database}/` });
  const manifests = objects.filter(object => object.key.endsWith('.manifest.json'));
  if (!manifests.length) throw new Error(`no stored backups for ${database}`);
  const wanted = stamp ? manifests.filter(object => object.key.includes(stamp)) : manifests;
  if (!wanted.length) throw new Error(`no stored backup for ${database} matching stamp ${stamp}`);
  // Keys are date-stamped, so lexicographic order is chronological order.
  const newest = wanted.sort((a, b) => (a.key < b.key ? 1 : -1))[0];
  const manifest = JSON.parse(await client.getObject(newest.key));
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`${newest.key} is not a usable manifest:\n- ${problems.join('\n- ')}`);

  const sqlKey = newest.key.replace(/\.manifest\.json$/, '.sql');
  const body = await client.getObjectBuffer(sqlKey);
  if (!body) throw new Error(`stored backup ${sqlKey} is missing`);
  const digest = sha256Bytes(body);
  if (digest !== manifest.sha256) throw new Error(`stored backup ${sqlKey} hashes to ${digest} but the manifest records ${manifest.sha256}`);
  if (body.length !== manifest.bytes) throw new Error(`stored backup ${sqlKey} is ${body.length} bytes but the manifest records ${manifest.bytes}`);

  mkdirSync(outDir, { recursive: true });
  const sqlPath = path.join(outDir, manifest.file);
  const manifestPath = path.join(outDir, `${manifest.file.replace(/\.sql$/, '')}.manifest.json`);
  writeFileSync(sqlPath, body);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { database, sqlKey, manifestKey: newest.key, sqlPath, manifestPath, manifest, bytes: body.length, sha256: digest };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/backup/download-backup.mjs --database <cflab|cflab-analytics> --out <dir> [--stamp <stamp>]');
    return;
  }
  const value = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const database = value('--database');
  const outDir = value('--out');
  if (!database || !outDir) throw new Error('--database and --out are required');
  const result = await downloadBackup({ database, outDir, stamp: value('--stamp') });
  console.log(`OK    ${database}: ${result.bytes} bytes, sha256 verified, captured ${result.manifest.captured_at} -> ${result.sqlPath}`);
  console.log(`      restore it with: node scripts/backup/restore-verify.mjs --manifest ${result.manifestPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
