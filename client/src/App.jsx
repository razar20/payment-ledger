import { useCallback, useEffect, useState } from 'react';
import { gql } from './api.js';
import AccountsPanel from './AccountsPanel.jsx';
import InvoicesPanel from './InvoicesPanel.jsx';
import LedgerPanel from './LedgerPanel.jsx';

const DASHBOARD_QUERY = /* GraphQL */ `
  query Dashboard {
    ledgerBalanced
    accounts { id name type balanceCents }
    invoices {
      id customer status dueDate totalCents paidCents remainingCents
      lineItems { id description quantity unitPriceCents totalCents }
      payments { id amountCents idempotencyKey createdAt }
    }
    transactions {
      id description idempotencyKey createdAt
      entries { id direction amountCents account { id name } }
    }
  }
`;

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('invoices');

  const refresh = useCallback(async () => {
    try {
      setData(await gql(DASHBOARD_QUERY));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="app">
      <header>
        <h1>Payment Ledger &amp; Invoices</h1>
        <div className="header-right">
          {data && (
            <span className={`badge ${data.ledgerBalanced ? 'ok' : 'err'}`}>
              {data.ledgerBalanced ? '✓ Ledger balanced' : '✗ LEDGER UNBALANCED'}
            </span>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <nav className="tabs">
        {['invoices', 'accounts', 'ledger'].map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <main>
          {tab === 'accounts' && <AccountsPanel accounts={data.accounts} onChange={refresh} />}
          {tab === 'invoices' && <InvoicesPanel invoices={data.invoices} onChange={refresh} />}
          {tab === 'ledger' && <LedgerPanel transactions={data.transactions} />}
        </main>
      )}
    </div>
  );
}
