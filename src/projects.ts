// Project identity, permissions, and physical storage are three separate
// concerns.
//
//   identity      -> the `apps` row in the primary `cflab` database
//   permissions   -> `project_memberships` (and users.is_admin) in the primary DB
//   storage       -> the D1 binding named in the `project_storage` registry
//
// The binding is resolved through this explicit, server-side allowlist. A
// request can never name a binding, a database id, or a table, so this module is
// the only place that decides which D1 handle a project's data comes from.

import type { Bindings } from './types';

export type StorageBinding = 'DB' | 'ANALYTICS' | 'BTC_SIGNALS';
export type StorageBackend = 'primary' | 'analytics' | 'bitcoin-signals';

export interface StorageBackendInfo {
  backend: StorageBackend;
  binding: StorageBinding;
  migrationsDir: string;
  label: string;
  description: string;
}

export const STORAGE_BACKENDS: Record<StorageBackend, StorageBackendInfo> = {
  primary: {
    backend: 'primary', binding: 'DB', migrationsDir: 'migrations',
    label: 'cflab (primary)',
    description: 'Project registry, users, sessions, memberships, shared records, and files.',
  },
  analytics: {
    backend: 'analytics', binding: 'ANALYTICS', migrationsDir: 'migrations-analytics',
    label: 'cflab-analytics',
    description: 'Analytics sites, events, and daily aggregates.',
  },
  'bitcoin-signals': {
    backend: 'bitcoin-signals', binding: 'BTC_SIGNALS', migrationsDir: 'migrations-bitcoin-signals',
    label: 'cflab-bitcoin-signals',
    description: 'Bitcoin Signals market observations, evidence, hypotheses, alerts, and collection history.',
  },
};

export const DEFAULT_BACKEND: StorageBackend = 'primary';

export function isStorageBackend(value: unknown): value is StorageBackend {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STORAGE_BACKENDS, value);
}

// Fail closed: an unrecognized registry row is a configuration error, not a
// reason to fall back to another database.
export function storageBackend(value: unknown): StorageBackendInfo {
  if (!isStorageBackend(value)) throw new Error(`unknown storage backend: ${String(value)}`);
  return STORAGE_BACKENDS[value];
}

export function storageBackendForBinding(value: unknown): StorageBackendInfo {
  const match = Object.values(STORAGE_BACKENDS).find(entry => entry.binding === value);
  if (!match) throw new Error(`unknown storage binding: ${String(value)}`);
  return match;
}

// The only function that turns a backend into a live binding. Every branch is
// explicit; there is no dynamic property lookup and no caller-supplied name.
export function databaseForBinding(env: Bindings, binding: StorageBinding): D1Database {
  switch (binding) {
    case 'DB': return env.DB;
    case 'ANALYTICS': return env.ANALYTICS;
    case 'BTC_SIGNALS': return env.BTC_SIGNALS;
    default: throw new Error(`unknown storage binding: ${String(binding)}`);
  }
}

export interface ProjectStorageRecord {
  app_id: string;
  backend: StorageBackend;
  binding: StorageBinding;
  migrations_dir: string;
  registered_at: string;
}

// Reads the registry for one project from the primary database, then validates
// the recorded binding against the allowlist. A row that names a binding the
// Worker does not implement is reported as unavailable rather than guessed.
export async function projectStorage(env: Bindings, appId: string): Promise<{ record: ProjectStorageRecord | null; backend: StorageBackendInfo; error?: string }> {
  const row = await env.DB.prepare('SELECT app_id, backend, binding, migrations_dir, registered_at FROM project_storage WHERE app_id = ?')
    .bind(appId).first<ProjectStorageRecord>();
  if (!row) return { record: null, backend: STORAGE_BACKENDS[DEFAULT_BACKEND] };
  try {
    const backend = storageBackend(row.backend);
    if (backend.binding !== row.binding) {
      return { record: row, backend, error: `registry binding ${row.binding} does not match backend ${row.backend}` };
    }
    return { record: row, backend };
  } catch (error) {
    return { record: row, backend: STORAGE_BACKENDS[DEFAULT_BACKEND], error: error instanceof Error ? error.message : 'invalid storage registry row' };
  }
}

export interface StorageHealth {
  backend: StorageBackend;
  binding: StorageBinding;
  label: string;
  migrations_dir: string;
  registered: boolean;
  reachable: boolean;
  error?: string;
}

// Read-only probe used by the administration screens. It runs one bounded SELECT
// per registered backend and reports reachability without exposing data.
export async function storageHealth(env: Bindings, appId: string): Promise<StorageHealth> {
  const { record, backend, error } = await projectStorage(env, appId);
  const health: StorageHealth = {
    backend: backend.backend, binding: backend.binding, label: backend.label,
    migrations_dir: record?.migrations_dir ?? backend.migrationsDir,
    registered: record !== null, reachable: false,
  };
  if (error) health.error = error;
  try {
    await databaseForBinding(env, backend.binding).prepare('SELECT 1 AS ok').first();
    health.reachable = true;
  } catch (probeError) {
    health.error = health.error ?? (probeError instanceof Error ? probeError.message : 'storage probe failed');
  }
  return health;
}

// Bitcoin Signals is a first-class project. Its identity lives in the primary
// database (migration 0011), its data in BTC_SIGNALS.
export const BITCOIN_SIGNALS = {
  appId: 'bitcoin-signals',
  name: 'Bitcoin Signals',
  dashboardPath: '/bitcoin-signals',
  backend: STORAGE_BACKENDS['bitcoin-signals'],
} as const;
