import { DomainError, ERR } from './errors.js';

/**
 * Core double-entry ledger service.
 *
 * Invariants enforced here:
 *  - Every transaction has at least one debit and one credit entry.
 *  - Sum of debits === sum of credits for every transaction.
 *  - Amounts are positive integers (cents). No floats, ever.
 *  - Balances are ALWAYS derived from the entry log (SUM over ledger_entries);
 *    there is no stored/mutable balance column anywhere.
 */
export function createLedger(db) {
  const stmts = {
    insertAccount: db.prepare('INSERT INTO accounts (name, type) VALUES (?, ?)'),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    getAccountByName: db.prepare('SELECT * FROM accounts WHERE name = ?'),
    listAccounts: db.prepare('SELECT * FROM accounts ORDER BY id'),
    insertTx: db.prepare('INSERT INTO ledger_transactions (description, idempotency_key) VALUES (?, ?)'),
    getTxByKey: db.prepare('SELECT * FROM ledger_transactions WHERE idempotency_key = ?'),
    getTx: db.prepare('SELECT * FROM ledger_transactions WHERE id = ?'),
    listTx: db.prepare('SELECT * FROM ledger_transactions ORDER BY id DESC'),
    insertEntry: db.prepare(
      'INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents) VALUES (?, ?, ?, ?)'
    ),
    entriesForTx: db.prepare('SELECT * FROM ledger_entries WHERE transaction_id = ? ORDER BY id'),
    // Derived balance: debits minus credits, sign-adjusted by account type below.
    debitCreditSums: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_cents END), 0) AS debits,
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents END), 0) AS credits
      FROM ledger_entries WHERE account_id = ?`),
    globalSums: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_cents END), 0) AS debits,
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents END), 0) AS credits
      FROM ledger_entries`),
  };

  function assertValidAmount(amountCents) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new DomainError(
        `Amount must be a positive integer number of cents, got: ${amountCents}`,
        ERR.INVALID_AMOUNT
      );
    }
  }

  function createAccount({ name, type }) {
    if (!name || !name.trim()) throw new DomainError('Account name is required', ERR.INVALID_STATE);
    try {
      const info = stmts.insertAccount.run(name.trim(), type);
      return stmts.getAccount.get(info.lastInsertRowid);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        throw new DomainError(`Account "${name}" already exists`, ERR.DUPLICATE);
      }
      throw e;
    }
  }

  function getAccount(id) {
    const acc = stmts.getAccount.get(id);
    if (!acc) throw new DomainError(`Account ${id} not found`, ERR.NOT_FOUND);
    return acc;
  }

  function getAccountByName(name) {
    const acc = stmts.getAccountByName.get(name);
    if (!acc) throw new DomainError(`Account "${name}" not found`, ERR.NOT_FOUND);
    return acc;
  }

  /**
   * Balance derived from the transaction log.
   * Debit-normal accounts (asset, expense): balance = debits - credits.
   * Credit-normal accounts (liability, equity, revenue): balance = credits - debits.
   */
  function getBalance(accountId) {
    const acc = getAccount(accountId);
    const { debits, credits } = stmts.debitCreditSums.get(accountId);
    const debitNormal = acc.type === 'asset' || acc.type === 'expense';
    return debitNormal ? debits - credits : credits - debits;
  }

  /**
   * Post a balanced double-entry transaction atomically.
   * If idempotencyKey was already used, returns the existing transaction (no re-apply).
   */
  const postTransaction = db.transaction(({ description, entries, idempotencyKey = null }) => {
    if (idempotencyKey) {
      const existing = stmts.getTxByKey.get(idempotencyKey);
      if (existing) return { transaction: existing, duplicate: true };
    }

    if (!Array.isArray(entries) || entries.length < 2) {
      throw new DomainError('A transaction needs at least two entries (one debit, one credit)', ERR.UNBALANCED);
    }

    let debits = 0;
    let credits = 0;
    for (const e of entries) {
      assertValidAmount(e.amountCents);
      getAccount(e.accountId); // existence check
      if (e.direction === 'debit') debits += e.amountCents;
      else if (e.direction === 'credit') credits += e.amountCents;
      else throw new DomainError(`Invalid direction: ${e.direction}`, ERR.UNBALANCED);
    }
    if (debits !== credits || debits === 0) {
      throw new DomainError(
        `Transaction is unbalanced: debits=${debits} credits=${credits}`,
        ERR.UNBALANCED
      );
    }

    const info = stmts.insertTx.run(description || '', idempotencyKey);
    const txId = info.lastInsertRowid;
    for (const e of entries) {
      stmts.insertEntry.run(txId, e.accountId, e.direction, e.amountCents);
    }
    return { transaction: stmts.getTx.get(txId), duplicate: false };
  });

  /** Convenience: move money from one account to another (debit `to`, credit `from` semantics vary by type; this is a raw debit/credit pair). */
  function transfer({ debitAccountId, creditAccountId, amountCents, description, idempotencyKey }) {
    return postTransaction({
      description,
      idempotencyKey,
      entries: [
        { accountId: debitAccountId, direction: 'debit', amountCents },
        { accountId: creditAccountId, direction: 'credit', amountCents },
      ],
    });
  }

  /** Global invariant check: total debits must equal total credits across the whole ledger. */
  function isBalanced() {
    const { debits, credits } = stmts.globalSums.get();
    return debits === credits;
  }

  return {
    createAccount,
    getAccount,
    getAccountByName,
    getBalance,
    listAccounts: () => stmts.listAccounts.all(),
    postTransaction,
    transfer,
    listTransactions: () => stmts.listTx.all(),
    entriesForTransaction: (txId) => stmts.entriesForTx.all(txId),
    isBalanced,
  };
}
