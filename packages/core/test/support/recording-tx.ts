import assert from 'node:assert/strict';
import type { QueryResultRow } from 'pg';
import type { Transaction } from '../../src/db.ts';

/**
 * A `Transaction` that records every statement instead of running it.
 *
 * Used to assert what a query *says* — which parameter is the account, which
 * placeholder the predicate binds — without a database. It is deliberately not
 * a substitute for running the SQL: `db/test/service-roles.integration.test.ts`
 * does that, against a real Postgres, and is skipped where there is none. This
 * is the half that runs everywhere.
 */

export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface RecordingTransaction extends Transaction {
  readonly statements: RecordedStatement[];
}

/**
 * @param rows what every `query` / `one` call returns. A function is called per
 *             statement, so a test can answer different statements differently.
 */
export function recordingTransaction(
  rows: unknown[] | ((statement: RecordedStatement) => unknown[]) = [],
): RecordingTransaction {
  const statements: RecordedStatement[] = [];
  const answer = (sql: string, params: readonly unknown[]): unknown[] => {
    const statement = { sql, params };
    statements.push(statement);
    return typeof rows === 'function' ? rows(statement) : rows;
  };

  return {
    statements,
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      return answer(sql, params) as R[];
    },
    async one<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R | null> {
      return (answer(sql, params)[0] as R | undefined) ?? null;
    },
  };
}

/**
 * Asserts that `statement` filters on `column` equal to the placeholder that
 * carries `value`.
 *
 * Finds the placeholder by the value's position in the parameter list rather
 * than by assuming `$1`, so it holds whichever way a query numbers its
 * parameters, and it fails when the value is passed but never compared — which
 * is the shape of the bug it exists to catch.
 */
export function assertScopedTo(
  statement: RecordedStatement,
  column: string,
  value: string,
  label = statement.sql.trim().split(/\s+/).slice(0, 6).join(' '),
): void {
  const index = statement.params.indexOf(value);
  assert.notEqual(index, -1, `${label}: the account is not among the parameters`);
  const placeholder = `\\$${index + 1}(?![0-9])`;
  const predicate = new RegExp(
    `${column.replace('.', '\\.')}\\s*=\\s*${placeholder}|${placeholder}\\s*=\\s*${column.replace('.', '\\.')}`,
  );
  assert.match(
    statement.sql,
    predicate,
    `${label}: no \`${column} = $${index + 1}\` predicate`,
  );
}
