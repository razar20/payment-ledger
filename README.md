# Mini Payment Ledger & Invoice Service

A small double-entry payment ledger and invoice service with a GraphQL API and a React UI. Built for the TMS Accounts Payable skill test.

**Stack:** Node.js 22+ · GraphQL (graphql-yoga) · SQLite (Node's built-in `node:sqlite` — zero native dependencies) · React 18 + Vite · plain CSS.

## How to run

Requires Node.js >= 22.13 (for built-in SQLite). No database server, no compiler, no env vars needed.

```bash
npm run setup   # installs server + client deps, builds the client
npm start       # serves UI + GraphQL on http://localhost:4000
```

- UI: http://localhost:4000
- GraphQL (with GraphiQL explorer): http://localhost:4000/graphql
- Health check: http://localhost:4000/health

For development with hot reload, run in two terminals: `npm run dev:server` and `npm run dev:client` (Vite dev server on :5173, proxying `/graphql` to :4000).

### Tests

```bash
npm test
```

25 tests across three suites: ledger invariants, invoice flow, and HTTP-level concurrency races.

## What it does

### Part 1 — Core ledger
- Create accounts (asset / liability / equity / revenue / expense) and post transactions between them via `postTransaction`.
- Every transaction is double-entry: at least one debit and one credit, and **sum(debits) must equal sum(credits)** or the transaction is rejected atomically.
- **Balances are never stored.** `Account.balanceCents` is always `SUM` over the entry log, sign-adjusted for the account's normal side (debit-normal for assets/expenses, credit-normal for the rest). There is no mutable balance column anywhere in the schema.
- **Money is integer cents.** All amounts are validated as positive integers; floats are rejected at the API boundary and by `CHECK` constraints in SQLite.

### Part 2 — Invoice flow
- Invoices have a customer, line items (qty × unit price in cents), a due date, and a lifecycle: `draft → sent → paid`, with `overdue` **derived** (sent + past due date), never stored — same philosophy as derived balances.
- Sending an invoice posts `DR Accounts Receivable / CR Revenue` (accrual revenue recognition). Applying a payment posts `DR Cash / CR Accounts Receivable`. The invoice sub-ledger and the general ledger always agree.
- Partial payments accumulate; the invoice flips to `paid` exactly when paid == total.
- **Overpayment** is rejected by re-checking `remaining = total − paid` inside the same DB transaction that inserts the payment.
- **Double-payment / duplicate webhooks:** every payment requires an idempotency key with a `UNIQUE` constraint. A replay returns the original payment with `duplicate: true` and applies nothing. (The UI has a "Replay last webhook" button to demo this.)

### Part 3 — Edge case: concurrent payments on the same invoice
The whole check-then-write sequence (replay check → state check → overpayment check → ledger posting → payment insert → status flip) runs inside a **single SQLite transaction opened with `BEGIN IMMEDIATE`**, which acquires the write lock up front. SQLite serializes writers, so two "simultaneous" payments can never both read the same remaining balance — the race is eliminated by serializing the critical section, not by hoping.

Covered by three HTTP-level tests that fire concurrent GraphQL mutations at a real server:
1. 10 racing payments of $60 against a $100 invoice → exactly 1 wins, 9 rejected as overpayment.
2. 10 racing partial payments of $10 against a $50 invoice → exactly 5 land, invoice settles to exactly paid.
3. 5 concurrent replays of the *same* webhook key → applied exactly once, all return the same payment.

In a production Postgres deployment the equivalent is `SELECT ... FOR UPDATE` on the invoice row (or `SERIALIZABLE` isolation with retry) — the principle is identical: make the read-check-write atomic.

## Design decisions

- **`node:sqlite` over better-sqlite3/Postgres:** same synchronous, serialized execution model as better-sqlite3 but built into Node — `npm install` needs no compiler and works on any platform. Right-sized for a take-home; the service layer takes `db` as a dependency, so swapping in Postgres means reimplementing ~10 prepared statements, not the domain logic.
- **Service layer separate from GraphQL:** `ledger.js` and `invoices.js` are plain modules with no GraphQL awareness; resolvers are a thin mapping layer. Domain errors carry machine-readable codes (`OVERPAYMENT`, `INVALID_STATE`, `UNBALANCED_TRANSACTION`, …) surfaced in GraphQL `extensions.code`.
- **Derived over stored, everywhere:** balances, invoice totals, paid amounts, remaining, and `overdue` status are all computed from source records. Nothing that can be derived is stored.
- **Idempotency at two levels:** ledger transactions and payments each have their own unique idempotency keys, so even internal retries can't double-post.

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

## Deploying (hosted UI)

Single web service — the server serves the built client.

**Render / Railway:** create a Node web service from this repo with build command `npm run setup` and start command `npm start`. SQLite writes to `server/data/ledger.db` (attach a persistent disk if you want data to survive restarts; for a demo, ephemeral is fine).
