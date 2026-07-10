import { useState } from 'react';
import { gql, fmtMoney } from './api.js';

const emptyItem = () => ({ description: '', quantity: 1, unitPrice: '' });

function CreateInvoiceForm({ onChange }) {
  const [customer, setCustomer] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [items, setItems] = useState([emptyItem()]);
  const [error, setError] = useState(null);

  function setItem(i, patch) {
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await gql(
        `mutation ($customer: String!, $dueDate: String!, $lineItems: [LineItemInput!]!) {
           createInvoice(customer: $customer, dueDate: $dueDate, lineItems: $lineItems) { id }
         }`,
        {
          customer,
          dueDate,
          lineItems: items.map((it) => ({
            description: it.description,
            quantity: Number(it.quantity),
            unitPriceCents: Math.round(Number(it.unitPrice) * 100),
          })),
        }
      );
      setCustomer('');
      setDueDate('');
      setItems([emptyItem()]);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card">
      <h2>New Invoice</h2>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={submit}>
        <div className="row-form">
          <input placeholder="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)} required />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </div>
        {items.map((it, i) => (
          <div className="row-form" key={i}>
            <input
              placeholder="Line item description"
              value={it.description}
              onChange={(e) => setItem(i, { description: e.target.value })}
              required
            />
            <input
              type="number" min="1" step="1" placeholder="Qty" className="short"
              value={it.quantity}
              onChange={(e) => setItem(i, { quantity: e.target.value })}
              required
            />
            <input
              type="number" min="0.01" step="0.01" placeholder="Unit price ($)" className="short"
              value={it.unitPrice}
              onChange={(e) => setItem(i, { unitPrice: e.target.value })}
              required
            />
            {items.length > 1 && (
              <button type="button" className="ghost" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row-form">
          <button type="button" className="ghost" onClick={() => setItems([...items, emptyItem()])}>
            + Add line item
          </button>
          <button type="submit">Create invoice</button>
        </div>
      </form>
    </div>
  );
}

function PayForm({ invoice, onChange }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function pay(e, idempotencyKey) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await gql(
        `mutation ($invoiceId: ID!, $amountCents: Int!, $idempotencyKey: String!) {
           applyPayment(invoiceId: $invoiceId, amountCents: $amountCents, idempotencyKey: $idempotencyKey) {
             duplicate
             payment { id }
           }
         }`,
        {
          invoiceId: invoice.id,
          amountCents: Math.round(Number(amount) * 100),
          idempotencyKey,
        }
      );
      if (res.applyPayment.duplicate) {
        setNotice('Duplicate webhook detected — payment was NOT applied twice.');
      } else {
        setAmount('');
      }
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  // A real webhook would carry its own key; the UI simulates one per attempt.
  const freshKey = () => `ui-${invoice.id}-${crypto.randomUUID()}`;
  const [lastKey, setLastKey] = useState(null);

  return (
    <form
      className="row-form pay-form"
      onSubmit={(e) => {
        const key = freshKey();
        setLastKey(key);
        pay(e, key);
      }}
    >
      <input
        type="number" min="0.01" step="0.01" placeholder="Payment amount ($)" className="short"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <button type="submit">Apply payment</button>
      {lastKey && (
        <button type="button" className="ghost" title="Simulates a payment webhook firing twice with the same idempotency key"
          onClick={(e) => pay(e, lastKey)}>
          Replay last webhook
        </button>
      )}
      {error && <span className="inline-error">{error}</span>}
      {notice && <span className="inline-notice">{notice}</span>}
    </form>
  );
}

function InvoiceCard({ invoice, onChange }) {
  const [error, setError] = useState(null);

  async function send() {
    setError(null);
    try {
      await gql(`mutation ($id: ID!) { sendInvoice(id: $id) { id status } }`, { id: invoice.id });
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  const payable = invoice.status === 'sent' || invoice.status === 'overdue';

  return (
    <div className="card invoice">
      <div className="invoice-head">
        <h3>
          #{invoice.id} — {invoice.customer}
        </h3>
        <span className={`pill status-${invoice.status}`}>{invoice.status}</span>
      </div>
      <p className="muted">Due {invoice.dueDate}</p>
      {error && <div className="banner error">{error}</div>}

      <table>
        <thead>
          <tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((li) => (
            <tr key={li.id}>
              <td>{li.description}</td>
              <td className="num">{li.quantity}</td>
              <td className="num">{fmtMoney(li.unitPriceCents)}</td>
              <td className="num">{fmtMoney(li.totalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan="3">Total</td><td className="num">{fmtMoney(invoice.totalCents)}</td></tr>
          <tr><td colSpan="3">Paid</td><td className="num">{fmtMoney(invoice.paidCents)}</td></tr>
          <tr className="strong"><td colSpan="3">Remaining</td><td className="num">{fmtMoney(invoice.remainingCents)}</td></tr>
        </tfoot>
      </table>

      {invoice.payments.length > 0 && (
        <details>
          <summary>{invoice.payments.length} payment(s)</summary>
          <ul className="payments">
            {invoice.payments.map((p) => (
              <li key={p.id}>
                {fmtMoney(p.amountCents)} — key <code>{p.idempotencyKey}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {invoice.status === 'draft' && <button onClick={send}>Send invoice</button>}
      {payable && <PayForm invoice={invoice} onChange={onChange} />}
    </div>
  );
}

export default function InvoicesPanel({ invoices, onChange }) {
  return (
    <section>
      <CreateInvoiceForm onChange={onChange} />
      {invoices.length === 0 && <p className="muted">No invoices yet — create one above.</p>}
      {invoices.map((inv) => (
        <InvoiceCard key={inv.id} invoice={inv} onChange={onChange} />
      ))}
    </section>
  );
}
