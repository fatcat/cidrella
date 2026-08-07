/**
 * Differential test: JS enums against the SQL CHECK constraints that shadow them.
 *
 * Several business rules are stated twice, once as a JavaScript list and once as
 * a `CHECK(col IN (...))` in a migration. Nothing keeps them in step. The failure
 * mode is nasty and late: a value passes every JS validator, reaches the INSERT,
 * and dies on a constraint violation in a route that had already told the caller
 * its input was fine.
 *
 * This reads the LIVE schema out of `sqlite_master` after all migrations have
 * run, rather than grepping the migration files. That matters because tables get
 * recreated and dropped along the way, so the constraint text in an early
 * migration is not necessarily the constraint that exists at the end. (The
 * blocklist category CHECK is the example: it looks alarming in
 * `010_blocklist_categories.sql` and is dead, because `018` drops the table.)
 *
 * The duplication here is not always removable: SQLite cannot import a JS array,
 * and the CHECK is a genuine last line of defence. What was missing was a test
 * that fails when the two drift. See REVIEW.md, duplicate-logic audit #40.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './../helpers/test-db.js';
import { ROLES } from '../../src/auth/roles.js';

let db;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => cleanupTestDb(tmpDir));

/**
 * Pull the allowed values out of a `CHECK(<column> IN ('a','b'))` in the live
 * CREATE TABLE statement. Returns a Set, or null when there is no such CHECK.
 */
function checkConstraintValues(tableName, column) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName);
  if (!row?.sql) return null;

  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const match = re.exec(row.sql);
  if (!match) return null;

  return new Set(
    match[1]
      .split(',')
      .map(s => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
  );
}

describe('JS enums match the SQL CHECK constraints in the live schema', () => {
  it('users.role accepts exactly the roles ROLES declares', () => {
    const sqlRoles = checkConstraintValues('users', 'role');
    expect(sqlRoles, 'no CHECK(role IN ...) found on users').not.toBeNull();

    const jsRoles = new Set(Object.keys(ROLES));

    // Reported both ways so a failure says which side gained the value.
    const onlyInJs = [...jsRoles].filter(r => !sqlRoles.has(r));
    const onlyInSql = [...sqlRoles].filter(r => !jsRoles.has(r));

    expect(onlyInJs, 'roles in auth/roles.js that the users.role CHECK would reject at INSERT '
      + '(add a migration widening the constraint)').toEqual([]);
    expect(onlyInSql, 'roles the users.role CHECK allows that auth/roles.js does not define '
      + '(no route can ever assign these)').toEqual([]);
  });

  it('a role added to only one side is caught', () => {
    // Guards the guard: proves the comparison above can actually fail, rather
    // than passing because checkConstraintValues silently returned an empty set.
    const sqlRoles = checkConstraintValues('users', 'role');
    const pretendJsRoles = new Set([...Object.keys(ROLES), 'auditor']);
    const onlyInJs = [...pretendJsRoles].filter(r => !sqlRoles.has(r));
    expect(onlyInJs).toEqual(['auditor']);
  });

  it('the live users.role CHECK is actually present and non-trivial', () => {
    const sqlRoles = checkConstraintValues('users', 'role');
    expect(sqlRoles.size).toBeGreaterThan(1);
    expect(sqlRoles.has('admin')).toBe(true);
  });
});
