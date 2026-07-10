export const typeDefs = /* GraphQL */ `
  enum AccountType { asset liability equity revenue expense }
  enum Direction { debit credit }
  enum InvoiceStatus { draft sent paid overdue }

  type Account {
    id: ID!
    name: String!
    type: AccountType!
    "Derived from the ledger entry log — never stored."
    balanceCents: Int!
    createdAt: String!
  }

  type LedgerEntry {
    id: ID!
    account: Account!
    direction: Direction!
    amountCents: Int!
  }

  type LedgerTransaction {
    id: ID!
    description: String!
    idempotencyKey: String
    entries: [LedgerEntry!]!
    createdAt: String!
  }

  type LineItem {
    id: ID!
    description: String!
    quantity: Int!
    unitPriceCents: Int!
    totalCents: Int!
  }

  type Payment {
    id: ID!
    invoiceId: ID!
    amountCents: Int!
    idempotencyKey: String!
    createdAt: String!
  }

  type Invoice {
    id: ID!
    customer: String!
    "Effective status: 'overdue' is derived (sent + past due), never stored."
    status: InvoiceStatus!
    dueDate: String!
    lineItems: [LineItem!]!
    totalCents: Int!
    paidCents: Int!
    remainingCents: Int!
    payments: [Payment!]!
    createdAt: String!
  }

  type ApplyPaymentResult {
    payment: Payment!
    invoice: Invoice!
    "True when this idempotency key was already processed (e.g. webhook replay). Nothing was re-applied."
    duplicate: Boolean!
  }

  input EntryInput {
    accountId: ID!
    direction: Direction!
    amountCents: Int!
  }

  input LineItemInput {
    description: String!
    quantity: Int!
    unitPriceCents: Int!
  }

  type Query {
    accounts: [Account!]!
    account(id: ID!): Account
    transactions: [LedgerTransaction!]!
    invoices: [Invoice!]!
    invoice(id: ID!): Invoice
    "Global double-entry invariant: total debits == total credits."
    ledgerBalanced: Boolean!
  }

  type Mutation {
    createAccount(name: String!, type: AccountType!): Account!
    postTransaction(description: String!, entries: [EntryInput!]!, idempotencyKey: String): LedgerTransaction!
    createInvoice(customer: String!, dueDate: String!, lineItems: [LineItemInput!]!): Invoice!
    sendInvoice(id: ID!): Invoice!
    applyPayment(invoiceId: ID!, amountCents: Int!, idempotencyKey: String!): ApplyPaymentResult!
  }
`;
