// Read-only SQL authorization for the administration workbench.
//
// D1 exposes no SQLite authorizer hook, so the boundary has to be structural:
//
//   1. a real tokenizer (not a regex) removes comments and understands string,
//      quoted-identifier and blob literals, so a `;` or keyword inside a literal
//      can never be mistaken for SQL;
//   2. exactly one statement is accepted, and it must begin with SELECT or WITH;
//   3. every statement-modifying keyword is refused anywhere in the token stream,
//      including inside a CTE (`WITH x AS (DELETE ...)`);
//   4. parameter placeholders are refused so the only bound values are the
//      pagination limits this module adds;
//   5. the statement is executed only as a derived table with an outer LIMIT, and
//      the D1 result metadata is checked afterwards: any reported row write means
//      the statement was not read-only and the result is discarded.
//
// This module is pure so the rules are unit-testable without a database.

export const MAX_SQL_LENGTH = 8_000;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE = 100;
// The largest row window the console will ever fetch: page size plus one probe
// row for paging, and the export bound.
export const MAX_FETCH_ROWS = 5_001;

export type SqlRejection =
  | 'sql_empty'
  | 'sql_too_long'
  | 'sql_unterminated_literal'
  | 'sql_unterminated_comment'
  | 'sql_multiple_statements'
  | 'sql_not_select'
  | 'sql_forbidden_keyword'
  | 'sql_parameters_unsupported'
  | 'sql_write_detected';

export class SqlRejected extends Error {
  constructor(public code: SqlRejection, message: string) {
    super(message);
    this.name = 'SqlRejected';
  }
}

// Keywords that can change schema, data, connections, transactions or the
// database file. `END` is deliberately absent: it terminates a CASE expression.
const FORBIDDEN_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'RETURNING',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'TRANSACTION',
  'TRIGGER', 'LOAD_EXTENSION', 'WRITEFILE', 'READFILE', 'FTS3_TOKENIZER',
]);

type TokenType = 'word' | 'number' | 'string' | 'quoted' | 'punct';
interface Token { type: TokenType; value: string; upper: string; start: number; end: number }

function isWordStart(character: string): boolean {
  return /[A-Za-z_]/.test(character) || (character > '\u007f' && /[\p{L}]/u.test(character));
}
function isWordPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character) || (character > '\u007f' && /[\p{L}\p{N}]/u.test(character));
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (/\s/.test(character)) { index += 1; continue; }

    // Line comment.
    if (character === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    // Block comment.
    if (character === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close === -1) throw new SqlRejected('sql_unterminated_comment', 'The statement has an unterminated comment');
      index = close + 2;
      continue;
    }
    // String literal: '' is an escaped quote.
    if (character === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new SqlRejected('sql_unterminated_literal', 'The statement has an unterminated literal');
      tokens.push({ type: 'string', value: sql.slice(start, index), upper: '', start, end: index });
      continue;
    }
    // Quoted identifiers: "name", `name`, [name].
    if (character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== ']' && sql[index + 1] === close) { index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new SqlRejected('sql_unterminated_literal', 'The statement has an unterminated identifier');
      tokens.push({ type: 'quoted', value: sql.slice(start, index), upper: '', start, end: index });
      continue;
    }
    // Numbers.
    if (/[0-9]/.test(character) || (character === '.' && next !== undefined && /[0-9]/.test(next))) {
      const start = index;
      while (index < sql.length && /[0-9a-fA-FxX.+-]/.test(sql[index]!)) {
        // Stop a `+`/`-` unless it follows an exponent marker.
        if ((sql[index] === '+' || sql[index] === '-') && !/[eE]/.test(sql[index - 1] ?? '')) break;
        index += 1;
      }
      tokens.push({ type: 'number', value: sql.slice(start, index), upper: '', start, end: index });
      continue;
    }
    // Words (keywords, identifiers, function names).
    if (isWordStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && isWordPart(sql[index]!)) index += 1;
      const value = sql.slice(start, index);
      tokens.push({ type: 'word', value, upper: value.toUpperCase(), start, end: index });
      continue;
    }
    tokens.push({ type: 'punct', value: character, upper: '', start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

export interface ReadOnlyStatement {
  /** The single statement with any trailing semicolon removed. */
  sql: string;
  /** Leading keyword, always SELECT or WITH. */
  keyword: 'SELECT' | 'WITH';
}

// The only supported way to turn a user string into executable SQL.
export function readOnlyStatement(input: unknown): ReadOnlyStatement {
  if (typeof input !== 'string' || input.trim() === '') throw new SqlRejected('sql_empty', 'Enter a statement to run');
  if (input.length > MAX_SQL_LENGTH) throw new SqlRejected('sql_too_long', `Statements are limited to ${MAX_SQL_LENGTH} characters`);
  const tokens = tokenize(input);
  if (!tokens.length) throw new SqlRejected('sql_empty', 'Enter a statement to run');

  const semicolons = tokens.filter(token => token.type === 'punct' && token.value === ';');
  if (semicolons.length > 1) throw new SqlRejected('sql_multiple_statements', 'Run exactly one statement at a time');
  if (semicolons.length === 1 && semicolons[0] !== tokens.at(-1)) {
    throw new SqlRejected('sql_multiple_statements', 'Run exactly one statement at a time');
  }
  const body = semicolons.length ? tokens.slice(0, -1) : tokens;
  if (!body.length) throw new SqlRejected('sql_empty', 'Enter a statement to run');

  // Bound parameters are unsupported: the pagination wrapper binds its own.
  for (const [position, token] of body.entries()) {
    if (token.type === 'punct' && token.value === '?') {
      throw new SqlRejected('sql_parameters_unsupported', 'Parameters are not supported; inline literal values');
    }
    if (token.type === 'punct' && (token.value === ':' || token.value === '@' || token.value === '$')
      && body[position + 1]?.type === 'word') {
      throw new SqlRejected('sql_parameters_unsupported', 'Parameters are not supported; inline literal values');
    }
  }

  const first = body[0]!;
  if (first.type !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    throw new SqlRejected('sql_not_select', 'Only SELECT statements and SELECT CTEs are allowed');
  }
  if (first.upper === 'WITH' && !body.some(token => token.type === 'word' && token.upper === 'SELECT')) {
    throw new SqlRejected('sql_not_select', 'The CTE must end in a SELECT');
  }
  for (const token of body) {
    if (token.type === 'word' && FORBIDDEN_KEYWORDS.has(token.upper)) {
      throw new SqlRejected('sql_forbidden_keyword', `${token.upper} is not allowed; this workbench is read-only`);
    }
  }
  return { sql: input.slice(first.start, body.at(-1)!.end), keyword: first.upper };
}

// The executed text is always a derived table with a hard outer LIMIT. Because
// `LIMIT`/`OFFSET` are validated integers, no user text reaches them.
export function pagedStatement(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FETCH_ROWS) throw new Error('invalid page size');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid offset');
  return `SELECT * FROM (\n${sql}\n) LIMIT ${limit} OFFSET ${offset}`;
}

export function pageBounds(page: unknown, pageSize: unknown): { page: number; pageSize: number; offset: number } {
  const parsedPage = Math.trunc(Number(page ?? 1));
  const parsedSize = Math.trunc(Number(pageSize ?? 50));
  const safePage = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.min(parsedPage, MAX_PAGE) : 1;
  const safeSize = Number.isFinite(parsedSize) && parsedSize >= 1 ? Math.min(parsedSize, MAX_PAGE_SIZE) : 50;
  return { page: safePage, pageSize: safeSize, offset: (safePage - 1) * safeSize };
}

// CSV output never lets a cell become a spreadsheet formula, and every cell is
// quoted only when it has to be.
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(column => csvCell(column)).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
