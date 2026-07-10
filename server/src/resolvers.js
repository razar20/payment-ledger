import { GraphQLError } from 'graphql';
import { DomainError } from './errors.js';

/** Translate domain errors into GraphQL errors with machine-readable codes. */
function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      if (e instanceof DomainError) {
        throw new GraphQLError(e.message, { extensions: { code: e.code } });
      }
      throw e;
    }
  };
}

export function createResolvers({ ledger, invoices }) {
  const mapAccount = (a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    createdAt: a.created_at,
    balanceCents: () => ledger.getBalance(a.id),
  });

  const mapTx = (t) => ({
    id: t.id,
    description: t.description,
    idempotencyKey: t.idempotency_key,
    createdAt: t.created_at,
    entries: () =>
      ledger.entriesForTransaction(t.id).map((e) => ({
        id: e.id,
        direction: e.direction,
        amountCents: e.amount_cents,
        account: () => mapAccount(ledger.getAccount(e.account_id)),
      })),
  });

  const mapPayment = (p) => ({
    id: p.id,
    invoiceId: p.invoice_id,
    amountCents: p.amount_cents,
    idempotencyKey: p.idempotency_key,
    createdAt: p.created_at,
  });

  const mapInvoice = (inv) => ({
    id: inv.id,
    customer: inv.customer,
    status: () => invoices.effectiveStatus(inv),
    dueDate: inv.due_date,
    createdAt: inv.created_at,
    lineItems: () =>
      invoices.lineItems(inv.id).map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unit_price_cents,
        totalCents: li.quantity * li.unit_price_cents,
      })),
    totalCents: () => invoices.totalCents(inv.id),
    paidCents: () => invoices.paidCents(inv.id),
    remainingCents: () => invoices.totalCents(inv.id) - invoices.paidCents(inv.id),
    payments: () => invoices.payments(inv.id).map(mapPayment),
  });

  return {
    Query: {
      accounts: () => ledger.listAccounts().map(mapAccount),
      account: guard((_, { id }) => mapAccount(ledger.getAccount(Number(id)))),
      transactions: () => ledger.listTransactions().map(mapTx),
      invoices: () => invoices.listInvoices().map(mapInvoice),
      invoice: guard((_, { id }) => mapInvoice(invoices.getInvoice(Number(id)))),
      ledgerBalanced: () => ledger.isBalanced(),
    },
    Mutation: {
      createAccount: guard((_, { name, type }) => mapAccount(ledger.createAccount({ name, type }))),
      postTransaction: guard((_, { description, entries, idempotencyKey }) => {
        const { transaction } = ledger.postTransaction({
          description,
          idempotencyKey,
          entries: entries.map((e) => ({
            accountId: Number(e.accountId),
            direction: e.direction,
            amountCents: e.amountCents,
          })),
        });
        return mapTx(transaction);
      }),
      createInvoice: guard((_, { customer, dueDate, lineItems }) =>
        mapInvoice(invoices.createInvoice({ customer, dueDate, lineItems }))
      ),
      sendInvoice: guard((_, { id }) => mapInvoice(invoices.sendInvoice(Number(id)))),
      applyPayment: guard((_, { invoiceId, amountCents, idempotencyKey }) => {
        const result = invoices.applyPayment({
          invoiceId: Number(invoiceId),
          amountCents,
          idempotencyKey,
        });
        return {
          payment: mapPayment(result.payment),
          invoice: mapInvoice(result.invoice),
          duplicate: result.duplicate,
        };
      }),
    },
  };
}
