import { fmtMoney } from './api.js';

export default function LedgerPanel({ transactions }) {
  return (
    <section>
      <div className="card">
        <h2>Transaction Log</h2>
        <p className="muted">
          Every transaction is double-entry: debits always equal credits.
        </p>
        {transactions.length === 0 && <p className="muted">No transactions yet.</p>}
        {transactions.map((tx) => (
          <div className="tx" key={tx.id}>
            <div className="tx-head">
              <strong>#{tx.id}</strong> {tx.description}
              <span className="muted"> · {tx.createdAt}</span>
            </div>
            <table>
              <tbody>
                {tx.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.account.name}</td>
                    <td className="num">{e.direction === 'debit' ? fmtMoney(e.amountCents) : ''}</td>
                    <td className="num">{e.direction === 'credit' ? fmtMoney(e.amountCents) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
