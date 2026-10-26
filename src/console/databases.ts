// The administration workbench's database allowlist and bound execution.
//
// Only the databases this Worker already binds can be reached. The identifier is
// resolved through the existing storage-backend allowlist in src/projects.ts, so
// no request can name a binding, a database id, a host or a table. Nothing here
// uses a Cloudflare API credential or a browser SQLite build.

import type { Bindings } from '../types';
import { ApiError } from '../http';
import { STORAGE_BACKENDS, databaseForBinding, type StorageBinding } from '../projects';
import { SqlRejected, pageBounds, pagedStatement, readOnlyStatement } from './sql';

export interface ConsoleDatabase {
  id: string;
  label: string;
  binding: StorageBinding;
  migrations_dir: string;
  description: string;
}

// Derived from the one authoritative storage map rather than duplicated.
export const CONSOLE_DATABASES: readonly ConsoleDatabase[] = Object.values(STORAGE_BACKENDS).map(backend => ({
  id: backend.backend,
  label: backend.label,
  binding: backend.binding,
  migrations_dir: backend.migrationsDir,
  description: backend.description,
}));

export function consoleDatabase(id: unknown): ConsoleDatabase {
  const match = typeof id === 'string' ? CONSOLE_DATABASES.find(database => database.id === id) : undefined;
  if (!match) throw new ApiError(404, 'database_not_allowed', 'Unknown database');
  return match;
}

export interface DatabaseInventory extends ConsoleDatabase {
  reachable: boolean;
  tables: number;
  indexes: number;
  views: number;
  error?: string;
}

interface MetaRow { tables: number | null; indexes: number | null; views: number | null }

export async function databaseInventory(env: Bindings): Promise<DatabaseInventory[]> {
  return await Promise.all(CONSOLE_DATABASES.map(async database => {
    const inventory: DatabaseInventory = { ...database, reachable: false, tables: 0, indexes: 0, views: 0 };
    try {
      // One bounded catalog read per database. D1 does not authorize
      // `sqlite_version()`, so the console reports structure, not a version.
      const row = await databaseForBinding(env, database.binding).prepare(
        `SELECT SUM(type = 'table') AS tables, SUM(type = 'index') AS indexes, SUM(type = 'view') AS views
         FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'`).first<MetaRow>();
      inventory.reachable = true;
      inventory.tables = Number(row?.tables ?? 0);
      inventory.indexes = Number(row?.indexes ?? 0);
      inventory.views = Number(row?.views ?? 0);
    } catch (error) {
      // Our own text or a driver string; it never contains result data.
      inventory.error = error instanceof Error ? error.message.slice(0, 200) : 'probe failed';
    }
    return inventory;
  }));
}

export interface ColumnInfo { name: string; type: string; not_null: boolean; default_value: string | null; primary_key: number }
export interface IndexInfo { name: string; table: string; unique: boolean; columns: string[] }
export interface TableInfo { name: string; columns: ColumnInfo[]; indexes: IndexInfo[] }
export interface DatabaseSchema {
  database: ConsoleDatabase;
  tables: TableInfo[];
  views: { name: string; sql: string | null }[];
  generated_at: string;
}

interface ColumnRow {
  cid: number; column_name: string; column_type: string;
  not_null: number; default_value: string | null; primary_key: number;
}
interface IndexRow { index_name: string; is_unique: number; column_name: string | null }

const MAX_SCHEMA_TABLES = 60;

// Schema browsing uses fixed internal SQL over SQLite's own catalog. The user
// never supplies a table name to this code path. D1's authorizer refuses a
// cross-table `pragma_table_info` join (its internal `_cf_*` tables are not
// readable), so each catalog table is described by its own constant-argument
// pragma call, batched into one round trip.
export async function databaseSchema(env: Bindings, id: unknown): Promise<DatabaseSchema> {
  const database = consoleDatabase(id);
  const db = databaseForBinding(env, database.binding);
  const objects = await db.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'
     ORDER BY type, name`).all<{ type: string; name: string; sql: string | null }>();

  const tableRows = objects.results.filter(entry => entry.type === 'table').slice(0, MAX_SCHEMA_TABLES);
  const statements = tableRows.flatMap(table => {
    const literal = `'${table.name.replace(/'/g, "''")}'`;
    return [
      db.prepare(`SELECT cid, name AS column_name, type AS column_type, "notnull" AS not_null,
                         dflt_value AS default_value, pk AS primary_key
                  FROM pragma_table_info(${literal}) ORDER BY cid`),
      db.prepare(`SELECT x.name AS index_name, x."unique" AS is_unique, ii.name AS column_name
                  FROM pragma_index_list(${literal}) x JOIN pragma_index_info(x.name) ii
                  ORDER BY x.name, ii.seqno`),
    ];
  });
  const results = statements.length ? await db.batch(statements) : [];

  const tables: TableInfo[] = tableRows.map((table, position) => {
    const columnRows = (results[position * 2]?.results ?? []) as unknown as ColumnRow[];
    const indexRows = (results[position * 2 + 1]?.results ?? []) as unknown as IndexRow[];
    const columns = columnRows.map(row => ({
      name: row.column_name, type: row.column_type, not_null: !!row.not_null,
      default_value: row.default_value, primary_key: Number(row.primary_key),
    }));
    const indexes: IndexInfo[] = [];
    for (const row of indexRows) {
      let index = indexes.find(entry => entry.name === row.index_name);
      if (!index) { index = { name: row.index_name, table: table.name, unique: !!row.is_unique, columns: [] }; indexes.push(index); }
      if (row.column_name) index.columns.push(row.column_name);
    }
    return { name: table.name, columns, indexes };
  });

  return {
    database,
    generated_at: new Date().toISOString(),
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    views: objects.results.filter(entry => entry.type === 'view').map(entry => ({ name: entry.name, sql: entry.sql })),
  };
}


export interface QueryMetrics {
  page: number; page_size: number; has_more: boolean;
  duration_ms: number; sql_duration_ms: number | null; rows_read: number | null; rows_written: number | null;
}
export interface QueryOutcome {
  database: ConsoleDatabase;
  columns: string[];
  rows: unknown[][];
  metrics: QueryMetrics;
}

interface D1MetaLike { duration?: number; rows_read?: number; rows_written?: number; changes?: number }

// Executes exactly one validated read-only statement. `fetchSize` rows are read
// (one more than the page) so the caller can offer a next page without counting.
export async function runReadOnlyQuery(
  env: Bindings, databaseId: unknown, sql: unknown, page?: unknown, pageSize?: unknown, fetchSize?: number,
): Promise<QueryOutcome> {
  const database = consoleDatabase(databaseId);
  const statement = readOnlyStatement(sql);
  const bounds = pageBounds(page, pageSize);
  const limit = Math.min(fetchSize ?? bounds.pageSize + 1, 5001);
  const started = Date.now();
  const result = await databaseForBinding(env, database.binding)
    .prepare(pagedStatement(statement.sql, limit, bounds.offset)).all<Record<string, unknown>>();
  const elapsed = Date.now() - started;
  const meta = (result.meta ?? {}) as D1MetaLike;

  // Defense in depth: the statement never reaches `run()`, and any reported row
  // write means the classification above was wrong. Discard and refuse.
  if (Number(meta.changes ?? 0) !== 0 || Number(meta.rows_written ?? 0) !== 0) {
    throw new SqlRejected('sql_write_detected', 'The statement attempted a write and was discarded');
  }

  const results = result.results ?? [];
  const hasMore = results.length > bounds.pageSize;
  const pageRows = hasMore ? results.slice(0, bounds.pageSize) : results;
  const columns = pageRows.length ? Object.keys(pageRows[0]!) : [];
  return {
    database,
    columns,
    rows: pageRows.map(row => columns.map(column => row[column] ?? null)),
    metrics: {
      page: bounds.page, page_size: bounds.pageSize, has_more: hasMore,
      duration_ms: elapsed,
      sql_duration_ms: typeof meta.duration === 'number' ? meta.duration : null,
      rows_read: typeof meta.rows_read === 'number' ? meta.rows_read : null,
      rows_written: typeof meta.rows_written === 'number' ? meta.rows_written : null,
    },
  };
}
