import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createLedger } from '../src/ledger.js';

describe('double-entry ledger core', () => {
  let db, ledger, cash, ar;

  beforeEach(() => {
    db = createDb(':memory:');
    ledger = createLedger(db);
    cash = ledger.getAccountByName('Cash');
    ar = ledger.getAccountByName('Accounts Receivable');
  });

  test('creates accounts', () => {
    const acc = ledger.createAccount({ name: 'Fuel Expense', type: 'expense' });
    assert.equal(acc.name, 'Fuel Expense');
    assert.equal(ledger.getBalance(acc.id), 0);
  });

  test('rejects duplicate account names', () => {
    assert.throws(() => ledger.createAccount({ name: 'Cash', type: 'asset' }), /already exists/);
  });

  test('posts a balanced transaction and derives balances from the log', () => {
    ledger.transfer({
      debitAccountId: cash.id,
      creditAccountId: ar.id,
      amountCents: 12345,
      description: 'test',
    });
    assert.equal(ledger.getBalance(cash.id), 12345);   // asset, debit-normal
    assert.equal(ledger.getBalance(ar.id), -12345);    // asset credited
    assert.ok(ledger.isBalanced());
  });

  test('balance is the SUM over entries — multiple transactions accumulate', () => {
    for (const amt of [100, 250, 999]) {
      ledger.transfer({ debitAccountId: cash.id, creditAccountId: ar.id, amountCents: amt, description: 't' });
    }
    assert.equal(ledger.getBalance(cash.id), 1349);
  });

  test('rejects unbalanced transactions', () => {
    assert.throws(
      () =>
        ledger.postTransaction({
          description: 'bad',
          entries: [
            { accountId: cash.id, direction: 'debit', amountCents: 100 },
            { accountId: ar.id, direction: 'credit', amountCents: 99 },
          ],
        }),
      /unbalanced/i
    );
    // Nothing was written
    assert.equal(ledger.listTransactions().length, 0);
    assert.equal(ledger.getBalance(cash.id), 0);
  });

  test('rejects single-entry transactions', () => {
    assert.throws(
      () =>
        ledger.postTransaction({
          description: 'bad',
          entries: [{ accountId: cash.id, direction: 'debit', amountCents: 100 }],
        }),
      /at least two entries/
    );
  });

  test('rejects non-integer (float) amounts — no floating point money', () => {
    assert.throws(
      () => ledger.transfer({ debitAccountId: cash.id, creditAccountId: ar.id, amountCents: 10.5, description: 't' }),
      /positive integer/
    );
  });

  test('rejects zero and negative amounts', () => {
    for (const amt of [0, -100]) {
      assert.throws(
        () => ledger.transfer({ debitAccountId: cash.id, creditAccountId: ar.id, amountCents: amt, description: 't' }),
        /positive integer/
      );
    }
  });

  test('rejects transactions against unknown accounts atomically', () => {
    assert.throws(
      () =>
        ledger.postTransaction({
          description: 'bad',
          entries: [
            { accountId: cash.id, direction: 'debit', amountCents: 100 },
            { accountId: 99999, direction: 'credit', amountCents: 100 },
          ],
        }),
      /not found/
    );
    assert.equal(ledger.listTransactions().length, 0);
  });

  test('idempotency: same key posts only once and returns the original', () => {
    const first = ledger.transfer({
      debitAccountId: cash.id, creditAccountId: ar.id, amountCents: 500,
      description: 'once', idempotencyKey: 'k-1',
    });
    const replay = ledger.transfer({
      debitAccountId: cash.id, creditAccountId: ar.id, amountCents: 500,
      description: 'once', idempotencyKey: 'k-1',
    });
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.transaction.id, first.transaction.id);
    assert.equal(ledger.getBalance(cash.id), 500); // applied exactly once
  });

  test('credit-normal accounts (revenue) report positive balances when credited', () => {
    const revenue = ledger.getAccountByName('Revenue');
    ledger.transfer({ debitAccountId: ar.id, creditAccountId: revenue.id, amountCents: 700, description: 'bill' });
    assert.equal(ledger.getBalance(revenue.id), 700);
    assert.equal(ledger.getBalance(ar.id), 700);
    assert.ok(ledger.isBalanced());
  });
});
