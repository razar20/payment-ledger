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

  test('posts balanced double-entry transactions', () => {
    for (const amt of [100, 250, 999]) {
      ledger.transfer({ debitAccountId: cash.id, creditAccountId: ar.id, amountCents: amt, description: 't' });
    }
    // Balance is SUM over entries — never a stored number.
    assert.equal(ledger.getBalance(cash.id), 1349);
    assert.equal(ledger.getBalance(ar.id), -1349);
    assert.ok(ledger.isBalanced()); // global invariant: Σ debits == Σ credits
  });

  test('rejects unbalanced transactions atomically ', () => {
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
    assert.equal(ledger.listTransactions().length, 0);
    assert.equal(ledger.getBalance(cash.id), 0);
  });

  test('money is integer cents only floats, zero, and negatives are rejected', () => {
    for (const amt of [10.5, 0, -100]) {
      assert.throws(
        () => ledger.transfer({ debitAccountId: cash.id, creditAccountId: ar.id, amountCents: amt, description: 't' }),
        /positive integer/
      );
    }
  });
});
