# Mini Payment Ledger & Invoice Service

A small double-entry payment ledger and invoice service with a GraphQL API and a React UI. Built for the TMS Accounts Payable.

**Stack:** Node.js 22+ · GraphQL (graphql-yoga) · SQLite (Node's built-in `node:sqlite` — zero native dependencies) · React 18 + Vite · plain CSS.

## How to run

Requires Node.js >= 22.13 (for built-in SQLite). No database server, no compiler, no env vars needed.

```bash
npm run setup   # installs server + client deps, builds the client
npm start       # serves UI + GraphQL on http://localhost:4000
```

- UI: http://localhost:4000
- GraphQL (with GraphiQL explorer): http://localhost:4000/graphql


For development with hot reload, run in two terminals: `npm run dev:server` and `npm run dev:client` (Vite dev server on :5173, proxying `/graphql` to :4000).

### Tests

```bash
npm test
```

7 focused tests across three suites — one per core requirement: double-entry balance enforcement (atomic rejection of unbalanced postings), derived balances, integer-cents money validation, partial payments and the paid transition, overpayment rejection, duplicate-webhook idempotency, and an HTTP-level concurrency race.


## Shortcuts taken (deliberately)

- **No auth / multi-tenancy** — out of scope for the test.
- **Single currency (USD)** — Part 3 offered currency handling as an alternative; I chose concurrency.
- **No pagination** on list queries; fine for a demo dataset.
- **Fixed system chart of accounts** (Cash, Accounts Receivable, Revenue) seeded at startup; invoice postings are hard-wired to them.
- **Timestamps as ISO strings** from SQLite rather than a proper DateTime scalar.
- **UI is intentionally plain** — plain CSS, a fetch-based GraphQL helper instead of Apollo Client, full refetch after each mutation instead of cache surgery. Right-sized for the scope.
- **The UI generates idempotency keys client-side** to simulate a payment provider's webhook; in reality keys come from the provider (e.g. Stripe event IDs).

## What I'd do differently with more time

- **Postgres + `SELECT ... FOR UPDATE`** (or SERIALIZABLE with retry), with migrations (e.g. node-pg-migrate) instead of a schema string.
- **Refund flow**: reversal transactions (`DR Revenue-contra / CR Cash`) linked to the original payment, keeping the ledger append-only rather than deleting anything.
- **Multi-currency**: currency column on accounts + invoices, minor-unit awareness (JPY has no cents), and a rates table; forbid cross-currency postings without an explicit FX pair of entries.
- **Cursor pagination** on transactions/invoices, and DataLoader to batch the N+1 balance lookups in list queries.
- **Property-based tests** asserting the global invariant (Σ debits = Σ credits) after arbitrary operation sequences.
- **Structured audit logging** and OpenTelemetry traces around payment application.
- **CI** (GitHub Actions: install → test → build) and a Dockerfile.

## API sketch

```graphql
mutation {
  createAccount(name: "Fuel Expense", type: expense) { id }

  postTransaction(description: "Manual entry", entries: [
    {accountId: 1, direction: debit,  amountCents: 5000},
    {accountId: 3, direction: credit, amountCents: 5000}
  ]) { id }

  createInvoice(customer: "Acme Freight", dueDate: "2026-08-01", lineItems: [
    {description: "Line haul", quantity: 2, unitPriceCents: 50000}
  ]) { id totalCents }

  sendInvoice(id: 1) { status }

  applyPayment(invoiceId: 1, amountCents: 40000, idempotencyKey: "wh_evt_123") {
    duplicate
    invoice { paidCents remainingCents status }
  }
}

query {
  accounts { name type balanceCents }
  invoices { id customer status totalCents remainingCents }
  transactions { description entries { account { name } direction amountCents } }
  ledgerBalanced   # global invariant: Σ debits == Σ credits
}
```

