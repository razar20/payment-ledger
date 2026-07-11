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

  function makeSentInvoice() {
    const inv = invoices.createInvoice({
      customer: 'Acme Freight',
      dueDate: '2027-01-31',
      lineItems: [
        { description: 'Line haul', quantity: 2, unitPriceCents: 50000 },      // $1000.00
        { description: 'Fuel surcharge', quantity: 1, unitPriceCents: 25000 }, // $250.00
      ],
    });
    invoices.sendInvoice(inv.id); // draft -> sent, posts DR A/R / CR Revenue
    return inv;
  }

  test('partial payments accumulate; invoice flips to paid exactly at total ledger agrees', () => {
    const inv = makeSentInvoice();
    assert.equal(invoices.totalCents(inv.id), 125000);

    invoices.applyPayment({ invoiceId: inv.id, amountCents: 100000, idempotencyKey: 'p1' });
    assert.equal(invoices.getInvoice(inv.id).status, 'sent'); // still open

    invoices.applyPayment({ invoiceId: inv.id, amountCents: 25000, idempotencyKey: 'p2' });
    assert.equal(invoices.getInvoice(inv.id).status, 'paid');

    // Ledger reflects it: Cash up by full amount, A/R settled back to zero.
    assert.equal(ledger.getBalance(ledger.getAccountByName('Cash').id), 125000);
    assert.equal(ledger.getBalance(ledger.getAccountByName('Accounts Receivable').id), 0);
    assert.ok(ledger.isBalanced());
  });

  test('overpayment is rejected paid total is unchanged', () => {
    const inv = makeSentInvoice();
    invoices.applyPayment({ invoiceId: inv.id, amountCents: 120000, idempotencyKey: 'p1' });
    assert.throws(
      () => invoices.applyPayment({ invoiceId: inv.id, amountCents: 6000, idempotencyKey: 'p2' }),
      /Overpayment rejected/
    );
    assert.equal(invoices.paidCents(inv.id), 120000);
  });

  test('double webhook fire: same idempotency key applies the payment exactly once', () => {
    const inv = makeSentInvoice();

    const first = invoices.applyPayment({ invoiceId: inv.id, amountCents: 50000, idempotencyKey: 'wh-abc' });
    const replay = invoices.applyPayment({ invoiceId: inv.id, amountCents: 50000, idempotencyKey: 'wh-abc' });

    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.payment.id, first.payment.id);
    assert.equal(invoices.paidCents(inv.id), 50000); // once, not twice
    assert.equal(ledger.getBalance(ledger.getAccountByName('Cash').id), 50000);
  });
});
