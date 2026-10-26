import { describe, expect, it } from 'vitest';
import { MAX_SQL_LENGTH, SqlRejected, csvCell, pageBounds, pagedStatement, readOnlyStatement, toCsv } from '../../src/console/sql';

function rejects(sql: unknown, code: string) {
  try {
    readOnlyStatement(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(SqlRejected);
    expect((error as SqlRejected).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('read-only SQL authorization', () => {
  it('accepts a single SELECT or SELECT CTE, with a trailing semicolon and comments', () => {
    expect(readOnlyStatement('SELECT 1').keyword).toBe('SELECT');
    expect(readOnlyStatement('  select id from users ;  ').sql).toBe('select id from users');
    expect(readOnlyStatement('-- leading comment\nSELECT 1').sql).toBe('SELECT 1');
    expect(readOnlyStatement('SELECT 1; -- done').sql).toBe('SELECT 1; -- done'.replace(/;.*$/, ''));
    expect(readOnlyStatement('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3) SELECT x FROM c').keyword).toBe('WITH');
    // CASE ... END is not a transaction keyword.
    expect(readOnlyStatement("SELECT CASE WHEN kind = 'a' THEN 1 ELSE 0 END FROM users").keyword).toBe('SELECT');
    // A semicolon inside a literal is not a statement separator.
    expect(readOnlyStatement("SELECT ';' AS semi").keyword).toBe('SELECT');
    // Quoted identifiers may contain keywords.
    expect(readOnlyStatement('SELECT "update", `delete`, [insert] FROM users').keyword).toBe('SELECT');
  });

  it('refuses anything that is not a single read statement', () => {
    rejects('', 'sql_empty');
    rejects('   ', 'sql_empty');
    rejects('-- only a comment', 'sql_empty');
    rejects('SELECT 1; SELECT 2', 'sql_multiple_statements');
    rejects('SELECT 1; DELETE FROM users', 'sql_multiple_statements');
    rejects('PRAGMA table_info(users)', 'sql_not_select');
    rejects('EXPLAIN SELECT 1', 'sql_not_select');
    rejects('WITH x AS (SELECT 1) DELETE FROM users', 'sql_forbidden_keyword');
    rejects('VALUES (1)', 'sql_not_select');
    rejects('x'.repeat(MAX_SQL_LENGTH + 1), 'sql_too_long');
  });

  it('refuses every write, DDL, connection and transaction keyword anywhere in the statement', () => {
    const forbidden = [
      'DELETE FROM users', 'UPDATE users SET is_admin = 1', 'INSERT INTO users (id) VALUES (1)',
      "REPLACE INTO users (id) VALUES (1)", 'CREATE TABLE x (id TEXT)', 'DROP TABLE users',
      'ALTER TABLE users ADD COLUMN x TEXT', "ATTACH DATABASE 'x.db' AS other", 'DETACH other',
      'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'RELEASE x',
      'TRIGGER', 'SELECT load_extension(\'x\')', 'WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x',
      'SELECT * FROM users RETURNING id',
    ];
    for (const sql of forbidden) {
      try {
        readOnlyStatement(sql);
        throw new Error(`expected refusal for ${sql}`);
      } catch (error) {
        expect(error).toBeInstanceOf(SqlRejected);
        expect(['sql_not_select', 'sql_forbidden_keyword']).toContain((error as SqlRejected).code);
      }
    }
  });

  it('refuses bound parameters and unterminated literals', () => {
    rejects('SELECT * FROM users WHERE id = ?', 'sql_parameters_unsupported');
    rejects('SELECT * FROM users WHERE id = $id', 'sql_parameters_unsupported');
    rejects('SELECT * FROM users WHERE id = :id', 'sql_parameters_unsupported');
    rejects('SELECT * FROM users WHERE id = @id', 'sql_parameters_unsupported');
    rejects("SELECT 'unterminated", 'sql_unterminated_literal');
    rejects('SELECT "unterminated', 'sql_unterminated_literal');
    rejects('SELECT 1 /* open', 'sql_unterminated_comment');
  });

  it('wraps the statement in a bounded derived table and clamps paging', () => {
    expect(pagedStatement('SELECT 1', 51, 0)).toContain('SELECT * FROM (\nSELECT 1\n) LIMIT 51 OFFSET 0');
    expect(() => pagedStatement('SELECT 1', 0, 0)).toThrow();
    expect(() => pagedStatement('SELECT 1', 10, -1)).toThrow();
    expect(() => pagedStatement('SELECT 1', 10.5, 0)).toThrow();
    expect(pageBounds(undefined, undefined)).toEqual({ page: 1, pageSize: 50, offset: 0 });
    expect(pageBounds(3, 20)).toEqual({ page: 3, pageSize: 20, offset: 40 });
    expect(pageBounds(-4, 10_000)).toEqual({ page: 1, pageSize: 200, offset: 0 });
    expect(pageBounds(1_000, 10)).toEqual({ page: 100, pageSize: 10, offset: 990 });
    expect(pageBounds('abc', 'abc')).toEqual({ page: 1, pageSize: 50, offset: 0 });
  });

  it('escapes CSV cells so a value cannot become a spreadsheet formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, '=x']])).toBe("a,b\r\n1,'=x\r\n");
  });
});
