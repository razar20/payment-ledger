import { DatabaseSync } from 'node:sqlite';

/**
 * Thin adapter over Node's built-in SQLite (node:sqlite, Node >= 22.13).
 *
 * Why not better-sqlite3? Same synchronous execution model, but zero native
 * dependencies — `npm install` works on any platform with no compiler.
 *
 * Provides the one thing node:sqlite lacks: a `transaction(fn)` helper with
 * nesting support (outermost = BEGIN IMMEDIATE, nested = SAVEPOINT).
 * BEGIN IMMEDIATE takes the write lock up front, so a competing writer can
 * never sneak in between our read (remaining balance) and write (payment row).
 */
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  let depth = 0;

  function transaction(fn) {
    return (...args) => {
      if (depth === 0) db.exec('BEGIN IMMEDIATE');
      else db.exec(`SAVEPOINT sp_${depth}`);
      depth++;
      try {
        const result = fn(...args);
        depth--;
        if (depth === 0) db.exec('COMMIT');
        else db.exec(`RELEASE sp_${depth}`);
        return result;
      } catch (err) {
        depth--;
        if (depth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO sp_${depth}; RELEASE sp_${depth}`);
        throw err;
      }
    };
  }

  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (p) => db.exec(`PRAGMA ${p}`),
    transaction,
    close: () => db.close(),
  };
}
