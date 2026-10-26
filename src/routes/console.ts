// Administration console API.
//
// Mounted under /api/admin, so every route here inherits the existing
// requireHumanAdmin middleware: a valid human session for an active administrator
// is required, machine tokens and ordinary project members are refused, and a
// non-administrator receives 403. No route accepts a database binding, a host, a
// Cloudflare credential, or arbitrary SQL outside the read-only gate.

import { Hono } from 'hono';
import type { ContextEnv } from '../types';
import { ApiError, fields, jsonBody, invalid, string } from '../http';
import { hashToken } from '../auth/crypto';
import { MAX_SQL_LENGTH, SqlRejected, readOnlyStatement, toCsv } from '../console/sql';
import { consoleDatabase, databaseInventory, databaseSchema, runReadOnlyQuery } from '../console/databases';
import { jobViews } from '../console/jobs';
import { overviewView, registryView, systemView } from '../console/overview';

export const consoleRoutes = new Hono<ContextEnv>();

const EXPORT_ROW_LIMIT = 2_000;
const SAVED_QUERY_LIMIT = 50;
const AUDIT_ERROR_MESSAGE_LIMIT = 200;

interface AuditEntry {
  userId: string;
  databaseId: string;
  sql: unknown;
  status: 'ok' | 'rejected' | 'error';
  errorCode?: string;
  rowCount?: number;
  durationMs: number;
}

// Only a hash of the statement is recorded, never its text or its results.
async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  const sql = typeof entry.sql === 'string' ? entry.sql : '';
  try {
    await db.prepare(
      `INSERT INTO console_query_audit (id, user_id, database_id, sql_hash, sql_length, status, error_code, row_count, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), entry.userId, entry.databaseId, await hashToken(sql), sql.length,
        entry.status, entry.errorCode ?? null, entry.rowCount ?? null, Math.max(0, Math.round(entry.durationMs)),
        new Date().toISOString()).run();
  } catch {
    // An audit write failure must not change the query verdict; the request log
    // still records the attempt and the console shows the audit table.
    console.error(JSON.stringify({ event: 'console_audit_write_failed' }));
  }
}

// Maps the read-only gate's codes to HTTP without ever echoing result data.
function queryFailure(error: unknown): ApiError {
  if (error instanceof SqlRejected) return new ApiError(400, error.code, error.message);
  if (error instanceof ApiError) return error;
  // SQLite's structural messages ("no such table: x", "near \"y\": syntax error")
  // are the point of a workbench; they contain schema text, not row data.
  const message = error instanceof Error ? error.message.slice(0, AUDIT_ERROR_MESSAGE_LIMIT) : 'The statement could not be executed';
  return new ApiError(400, 'sql_error', message);
}

function sqlInput(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_SQL_LENGTH) {
    invalid(`A statement of at most ${MAX_SQL_LENGTH} characters is required`);
  }
  return value;
}

consoleRoutes.get('/overview', async c => {
  const user = c.get('user')!;
  return c.json(await overviewView(c.env, { email: user.email, is_admin: user.is_admin }));
});

consoleRoutes.get('/registry', async c => c.json(await registryView(c.env.DB)));

consoleRoutes.get('/jobs', async c => c.json(await jobViews(c.env)));

consoleRoutes.get('/system', async c => c.json(await systemView(c.env)));

consoleRoutes.get('/databases', async c => c.json({ databases: await databaseInventory(c.env) }));

consoleRoutes.get('/databases/:id/schema', async c => c.json(await databaseSchema(c.env, c.req.param('id'))));

consoleRoutes.post('/databases/:id/query', async c => {
  const user = c.get('user')!;
  const body = await jsonBody(c.req.raw);
  fields(body, ['sql', 'page', 'page_size']);
  const databaseId = consoleDatabase(c.req.param('id')).id;
  const started = Date.now();
  try {
    const outcome = await runReadOnlyQuery(c.env, databaseId, sqlInput(body.sql), body.page, body.page_size);
    await recordAudit(c.env.DB, {
      userId: user.id, databaseId, sql: body.sql, status: 'ok',
      rowCount: outcome.rows.length, durationMs: Date.now() - started,
    });
    return c.json(outcome);
  } catch (error) {
    const failure = queryFailure(error);
    const code = error instanceof SqlRejected ? error.code : failure.code;
    await recordAudit(c.env.DB, {
      userId: user.id, databaseId, sql: body.sql,
      status: code.startsWith('sql_') && error instanceof SqlRejected ? 'rejected' : 'error',
      errorCode: code, durationMs: Date.now() - started,
    });
    throw failure;
  }
});

consoleRoutes.post('/databases/:id/export', async c => {
  const user = c.get('user')!;
  const body = await jsonBody(c.req.raw);
  fields(body, ['sql']);
  const databaseId = consoleDatabase(c.req.param('id')).id;
  const started = Date.now();
  try {
    const outcome = await runReadOnlyQuery(c.env, databaseId, sqlInput(body.sql), 1, EXPORT_ROW_LIMIT, EXPORT_ROW_LIMIT + 1);
    if (outcome.metrics.has_more) {
      throw new ApiError(413, 'export_too_large', `The result exceeds ${EXPORT_ROW_LIMIT} rows; narrow the statement`);
    }
    await recordAudit(c.env.DB, {
      userId: user.id, databaseId, sql: body.sql, status: 'ok',
      rowCount: outcome.rows.length, durationMs: Date.now() - started,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return c.body(toCsv(outcome.columns, outcome.rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="cflab-${databaseId}-${stamp}.csv"`,
    });
  } catch (error) {
    const failure = queryFailure(error);
    const code = error instanceof SqlRejected ? error.code : failure.code;
    await recordAudit(c.env.DB, {
      userId: user.id, databaseId, sql: body.sql,
      status: code.startsWith('sql_') && error instanceof SqlRejected ? 'rejected' : 'error',
      errorCode: code, durationMs: Date.now() - started,
    });
    throw failure;
  }
});

// Saved statements are scoped to the calling administrator in every query, so one
// administrator can never read or delete another's.
consoleRoutes.get('/saved-queries', async c => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT id, database_id, name, sql_text, created_at, updated_at FROM console_saved_queries
     WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 100`).bind(user.id)
    .all<{ id: string; database_id: string; name: string; sql_text: string; created_at: string; updated_at: string }>();
  return c.json({ queries: results });
});

consoleRoutes.post('/saved-queries', async c => {
  const user = c.get('user')!;
  const body = await jsonBody(c.req.raw);
  fields(body, ['name', 'database_id', 'sql']);
  const name = string(body.name, 'name', 80);
  const database = consoleDatabase(body.database_id);
  const sql = sqlInput(body.sql);
  try {
    readOnlyStatement(sql);
  } catch (error) {
    throw queryFailure(error);
  }
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM console_saved_queries WHERE user_id = ?')
    .bind(user.id).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= SAVED_QUERY_LIMIT) {
    throw new ApiError(409, 'saved_query_limit', `At most ${SAVED_QUERY_LIMIT} statements can be saved`);
  }
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), database_id: database.id, name, sql_text: sql, created_at: now, updated_at: now };
  await c.env.DB.prepare(
    `INSERT INTO console_saved_queries (id, user_id, database_id, name, sql_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, user.id, row.database_id, row.name, row.sql_text, row.created_at, row.updated_at).run();
  return c.json(row, 201);
});

consoleRoutes.delete('/saved-queries/:id', async c => {
  const user = c.get('user')!;
  const result = await c.env.DB.prepare('DELETE FROM console_saved_queries WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id).run();
  if (!result.meta.changes) throw new ApiError(404, 'saved_query_not_found', 'Saved statement not found');
  return c.body(null, 204);
});

