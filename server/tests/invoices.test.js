import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createLedger } from '../src/ledger.js';
import { createInvoiceService } from '../src/invoices.js';

describe('invoice flow', () => {
  let db, ledger, invoices;

  beforeEach(() => {
    db = createDb(':memory:');
    ledger = createLedger(db);
    invoices = createInvoiceService(db, ledger);
  });

  function makeInvoice({ dueDate = '2027-01-31' } = {}) {
    return invoices.createInvoice({
      customer: 'Acme Freight',
      dueDate,
      lineItems: [
        { description: 'Line haul', quantity: 2, unitPriceCents: 50000 },  // $1000.00
        { description: 'Fuel surcharge', quantity: 1, unitPriceCents: 25000 }, // $250.00
      ],
    });
  }

  test('creates invoice with line items; total derived from line items', () => {
    const inv = makeInvoice();
    assert.equal(inv.status, 'draft');
    assert.equal(invoices.totalCents(inv.id), 125000);
    assert.equal(invoices.lineItems(inv.id).length, 2);
  });

  test('rejects invoices without line items', () => {
    assert.throws(
      () => invoices.createInvoice({ customer: 'X', dueDate: '2027-01-01', lineItems: [] }),
      /at least one line item/
    );
  });

  test('sending an invoice recognizes revenue in the ledger (DR A/R, CR Revenue)', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);
    assert.equal(ledger.getBalance(ledger.getAccountByName('Accounts Receivable').id), 125000);
    assert.equal(ledger.getBalance(ledger.getAccountByName('Revenue').id), 125000);
    assert.ok(ledger.isBalanced());
  });

  test('cannot send an invoice twice', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);
    assert.throws(() => invoices.sendInvoice(inv.id), /Only draft invoices/);
  });

  test('cannot pay a draft invoice', () => {
    const inv = makeInvoice();
    assert.throws(
      () => invoices.applyPayment({ invoiceId: inv.id, amountCents: 1000, idempotencyKey: 'p1' }),
      /draft/
    );
  });

  test('partial payments accumulate; invoice flips to paid exactly at total', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);

    invoices.applyPayment({ invoiceId: inv.id, amountCents: 100000, idempotencyKey: 'p1' });
    assert.equal(invoices.paidCents(inv.id), 100000);
    assert.equal(invoices.getInvoice(inv.id).status, 'sent'); // still open

    invoices.applyPayment({ invoiceId: inv.id, amountCents: 25000, idempotencyKey: 'p2' });
    assert.equal(invoices.paidCents(inv.id), 125000);
    assert.equal(invoices.getInvoice(inv.id).status, 'paid');

    // Ledger reflects it: Cash up by full amount, A/R back to zero.
    assert.equal(ledger.getBalance(ledger.getAccountByName('Cash').id), 125000);
    assert.equal(ledger.getBalance(ledger.getAccountByName('Accounts Receivable').id), 0);
    assert.ok(ledger.isBalanced());
  });

  test('overpayment is rejected', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);
    invoices.applyPayment({ invoiceId: inv.id, amountCents: 120000, idempotencyKey: 'p1' });
    assert.throws(
      () => invoices.applyPayment({ invoiceId: inv.id, amountCents: 6000, idempotencyKey: 'p2' }),
      /Overpayment rejected/
    );
    assert.equal(invoices.paidCents(inv.id), 120000); // unchanged
  });

  test('paying a fully paid invoice is rejected', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);
    invoices.applyPayment({ invoiceId: inv.id, amountCents: 125000, idempotencyKey: 'p1' });
    assert.throws(
      () => invoices.applyPayment({ invoiceId: inv.id, amountCents: 1, idempotencyKey: 'p2' }),
      /already fully paid/
    );
  });

  test('double webhook fire: same idempotency key applies the payment exactly once', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);

    const first = invoices.applyPayment({ invoiceId: inv.id, amountCents: 50000, idempotencyKey: 'wh-abc' });
    const replay = invoices.applyPayment({ invoiceId: inv.id, amountCents: 50000, idempotencyKey: 'wh-abc' });

    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.payment.id, first.payment.id);
    assert.equal(invoices.paidCents(inv.id), 50000); // once, not twice
    assert.equal(ledger.getBalance(ledger.getAccountByName('Cash').id), 50000);
  });

  test('payments require an idempotency key', () => {
    const inv = makeInvoice();
    invoices.sendInvoice(inv.id);
    assert.throws(
      () => invoices.applyPayment({ invoiceId: inv.id, amountCents: 1000, idempotencyKey: '' }),
      /idempotencyKey is required/
    );
  });

  test('overdue is a derived status: sent + past due date', () => {
    const pastDue = makeInvoice({ dueDate: '2020-01-01' });
    invoices.sendInvoice(pastDue.id);
    assert.equal(invoices.effectiveStatus(invoices.getInvoice(pastDue.id)), 'overdue');

    const future = makeInvoice({ dueDate: '2099-01-01' });
    invoices.sendInvoice(future.id);
    assert.equal(invoices.effectiveStatus(invoices.getInvoice(future.id)), 'sent');

    // A paid invoice past its due date is paid, not overdue.
    invoices.applyPayment({ invoiceId: pastDue.id, amountCents: 125000, idempotencyKey: 'p-past' });
    assert.equal(invoices.effectiveStatus(invoices.getInvoice(pastDue.id)), 'paid');
  });
});
