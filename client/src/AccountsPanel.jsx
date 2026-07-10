import { useState } from 'react';
import { gql, fmtMoney } from './api.js';

export default function AccountsPanel({ accounts, onChange }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('asset');
  const [error, setError] = useState(null);

  async function createAccount(e) {
    e.preventDefault();
    setError(null);
    try {
      await gql(
        `mutation ($name: String!, $type: AccountType!) {
           createAccount(name: $name, type: $type) { id }
         }`,
        { name, type }
      );
      setName('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section>
      <div className="card">
        <h2>Chart of Accounts</h2>
        <p className="muted">Balances are derived from the transaction log — never stored.</p>
        <table>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Type</th><th className="num">Balance</th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.name}</td>
                <td><span className={`pill type-${a.type}`}>{a.type}</span></td>
                <td className="num">{fmtMoney(a.balanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>New Account</h2>
        {error && <div className="banner error">{error}</div>}
        <form onSubmit={createAccount} className="row-form">
          <input
            placeholder="Account name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {['asset', 'liability', 'equity', 'revenue', 'expense'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button type="submit">Create</button>
        </form>
      </div>
    </section>
  );
}
