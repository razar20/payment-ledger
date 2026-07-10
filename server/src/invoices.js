import { DomainError, ERR } from './errors.js';

/**
 * Invoice service, built on top of the double-entry ledger.
 *
 * Accounting model (accrual):
 *  - sendInvoice:  DEBIT Accounts Receivable / CREDIT Revenue  (revenue recognized when billed)
 *  - applyPayment: DEBIT Cash                / CREDIT Accounts Receivable
 *
 * Status lifecycle: draft -> sent -> paid. "overdue" is a DERIVED status
 * (sent + past due date), never stored — same principle as derived balances.
 *
 * Safety:
 *  - Overpayment rejected: remaining balance is re-checked INSIDE the same
 *    DB transaction that inserts the payment.
 *  - Double-payment (webhook firing twice) is idempotent: payments carry a
 *    UNIQUE idempotency key; a replay returns the original payment untouched.
 *  - Concurrency (Part 3): the whole check-then-write runs inside a single
 *    better-sqlite3 transaction, which executes synchronously and atomically —
 *    SQLite serializes writers, so two "simultaneous" payments can never both
 *    read the same remaining balance. See README for the Postgres equivalent
 *    (SELECT ... FOR UPDATE).
 */
export function createInvoiceService(db, ledger) {
  const stmts = {
    insertInvoice: db.prepare('INSERT INTO invoices (customer, due_date) VALUES (?, ?)'),
    getInvoice: db.prepare('SELECT * FROM invoices WHERE id = ?'),
    listInvoices: db.prepare('SELECT * FROM invoices ORDER BY id DESC'),
    setStatus: db.prepare('UPDATE invoices SET status = ? WHERE id = ?'),
    insertLineItem: db.prepare(
      'INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_cents) VALUES (?, ?, ?, ?)'
    ),
    lineItems: db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'),
    invoiceTotal: db.prepare(
      'SELECT COALESCE(SUM(quantity * unit_price_cents), 0) AS total FROM invoice_line_items WHERE invoice_id = ?'
    ),
    paidTotal: db.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE invoice_id = ?'
    ),
    paymentByKey: db.prepare('SELECT * FROM payments WHERE idempotency_key = ?'),
    insertPayment: db.prepare(
      'INSERT INTO payments (invoice_id, amount_cents, idempotency_key, transaction_id) VALUES (?, ?, ?, ?)'
    ),
    getPayment: db.prepare('SELECT * FROM payments WHERE id = ?'),
    paymentsForInvoice: db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id'),
  };

  function getInvoice(id) {
    const inv = stmts.getInvoice.get(id);
    if (!inv) throw new DomainError(`Invoice ${id} not found`, ERR.NOT_FOUND);
    return inv;
  }

  function totalCents(invoiceId) {
    return stmts.invoiceTotal.get(invoiceId).total;
  }

  function paidCents(invoiceId) {
    return stmts.paidTotal.get(invoiceId).paid;
  }

  /** 'overdue' is derived, not stored. */
  function effectiveStatus(inv, now = new Date()) {
    if (inv.status === 'sent' && new Date(inv.due_date + 'T23:59:59Z') < now) return 'overdue';
    return inv.status;
  }

  const createInvoice = db.transaction(({ customer, dueDate, lineItems }) => {
    if (!customer || !customer.trim()) throw new DomainError('Customer is required', ERR.INVALID_STATE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) {
      throw new DomainError('dueDate must be YYYY-MM-DD', ERR.INVALID_STATE);
    }
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new DomainError('An invoice needs at least one line item', ERR.INVALID_STATE);
    }
    for (const li of lineItems) {
      if (!Number.isInteger(li.quantity) || li.quantity <= 0) {
        throw new DomainError(`Invalid quantity: ${li.quantity}`, ERR.INVALID_AMOUNT);
      }
      if (!Number.isInteger(li.unitPriceCents) || li.unitPriceCents <= 0) {
        throw new DomainError(`Invalid unit price (cents): ${li.unitPriceCents}`, ERR.INVALID_AMOUNT);
      }
    }
    const info = stmts.insertInvoice.run(customer.trim(), dueDate);
    const invoiceId = info.lastInsertRowid;
    for (const li of lineItems) {
      stmts.insertLineItem.run(invoiceId, li.description || '', li.quantity, li.unitPriceCents);
    }
    return getInvoice(invoiceId);
  });

  /** draft -> sent. Recognizes revenue: DR Accounts Receivable / CR Revenue. */
  const sendInvoice = db.transaction((invoiceId) => {
    const inv = getInvoice(invoiceId);
    if (inv.status !== 'draft') {
      throw new DomainError(`Only draft invoices can be sent (invoice is "${inv.status}")`, ERR.INVALID_STATE);
    }
    const total = totalCents(invoiceId);
    ledger.transfer({
      debitAccountId: ledger.getAccountByName('Accounts Receivable').id,
      creditAccountId: ledger.getAccountByName('Revenue').id,
      amountCents: total,
      description: `Invoice #${invoiceId} sent to ${inv.customer}`,
      idempotencyKey: `invoice-${invoiceId}-sent`,
    });
    stmts.setStatus.run('sent', invoiceId);
    return getInvoice(invoiceId);
  });

  /**
   * Apply a (possibly partial) payment to an invoice.
   *
   * The entire check-then-write sequence is one atomic DB transaction:
   *   1. replay check on idempotency key  -> return original payment, apply nothing
   *   2. invoice must be payable (sent/overdue, not draft, not already paid)
   *   3. overpayment check against remaining = total - paid
   *   4. ledger posting (DR Cash / CR A/R) + payment row insert
   *   5. flip status to 'paid' when fully settled
   */
  const applyPayment = db.transaction(({ invoiceId, amountCents, idempotencyKey }) => {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new DomainError('idempotencyKey is required for payments', ERR.INVALID_STATE);
    }

    // 1. Idempotent replay: the webhook fired twice — return the original result.
    const existing = stmts.paymentByKey.get(idempotencyKey);
    if (existing) {
      return { payment: existing, invoice: getInvoice(existing.invoice_id), duplicate: true };
    }

    const inv = getInvoice(invoiceId);

    // 2. State check.
    if (inv.status === 'draft') {
      throw new DomainError('Cannot pay a draft invoice — send it first', ERR.INVALID_STATE);
    }
    if (inv.status === 'paid') {
      throw new DomainError('Invoice is already fully paid', ERR.INVALID_STATE);
    }

    // 3. Overpayment check, inside the transaction, against derived paid total.
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new DomainError(`Payment amount must be a positive integer of cents, got: ${amountCents}`, ERR.INVALID_AMOUNT);
    }
    const total = totalCents(invoiceId);
    const paid = paidCents(invoiceId);
    const remaining = total - paid;
    if (amountCents > remaining) {
      throw new DomainError(
        `Overpayment rejected: invoice #${invoiceId} has ${remaining} cents remaining, attempted ${amountCents}`,
        ERR.OVERPAYMENT
      );
    }

    // 4. Ledger posting + payment record.
    const { transaction } = ledger.transfer({
      debitAccountId: ledger.getAccountByName('Cash').id,
      creditAccountId: ledger.getAccountByName('Accounts Receivable').id,
      amountCents,
      description: `Payment of ${amountCents}c on invoice #${invoiceId}`,
      idempotencyKey: `payment-${idempotencyKey}`,
    });
    const info = stmts.insertPayment.run(invoiceId, amountCents, idempotencyKey, transaction.id);

    // 5. Fully settled?
    if (paid + amountCents === total) {
      stmts.setStatus.run('paid', invoiceId);
    }

    return { payment: stmts.getPayment.get(info.lastInsertRowid), invoice: getInvoice(invoiceId), duplicate: false };
  });

  return {
    createInvoice,
    sendInvoice,
    applyPayment,
    getInvoice,
    listInvoices: () => stmts.listInvoices.all(),
    lineItems: (invoiceId) => stmts.lineItems.all(invoiceId),
    payments: (invoiceId) => stmts.paymentsForInvoice.all(invoiceId),
    totalCents,
    paidCents,
    effectiveStatus,
  };
}
