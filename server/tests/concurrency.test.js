import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

/**
 * Part 3 edge case: concurrent payments hitting the same invoice.
 *
 * Fires many simultaneous GraphQL requests against a real HTTP server, each
 * trying to take a big bite out of the same invoice. If the check-then-write
 * were not atomic, several would read the same "remaining" and overpay.
 */
describe('concurrent payments on the same invoice', () => {
  async function gql(url, query, variables) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }

  test('N racing payments cannot overpay the invoice ledger stays balanced', async () => {
    const { app, invoices, ledger } = await createApp({ dbPath: ':memory:' });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://localhost:${server.address().port}/graphql`;

    try {
      // Invoice for $100.00
      const inv = invoices.createInvoice({
        customer: 'Race Corp',
        dueDate: '2027-12-31',
        lineItems: [{ description: 'Load', quantity: 1, unitPriceCents: 10000 }],
      });
      invoices.sendInvoice(inv.id);

      // 10 concurrent payments of $60.00 each — only ONE can possibly fit.
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          gql(
            url,
            `mutation ($invoiceId: ID!, $amountCents: Int!, $idempotencyKey: String!) {
               applyPayment(invoiceId: $invoiceId, amountCents: $amountCents, idempotencyKey: $idempotencyKey) {
                 duplicate
                 payment { id amountCents }
                 invoice { paidCents remainingCents status }
               }
             }`,
            { invoiceId: String(inv.id), amountCents: 6000, idempotencyKey: `race-${i}` }
          )
        )
      );

      const successes = results.filter((r) => r.data?.applyPayment);
      const overpaymentErrors = results.filter((r) =>
        r.errors?.some((e) => e.extensions?.code === 'OVERPAYMENT')
      );

      assert.equal(successes.length, 1, 'exactly one racing payment should win');
      assert.equal(overpaymentErrors.length, N - 1, 'the rest must be rejected as overpayment');
      assert.equal(invoices.paidCents(inv.id), 6000, 'paid total must never exceed what fits');
      assert.ok(invoices.paidCents(inv.id) <= invoices.totalCents(inv.id));
      assert.ok(ledger.isBalanced(), 'ledger must remain balanced after the race');
    } finally {
      server.close();
    }
  });
});
