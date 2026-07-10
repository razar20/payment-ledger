/** Minimal GraphQL client — a fetch wrapper is all this app needs. */
export async function gql(query, variables = {}) {
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    const err = new Error(json.errors[0].message);
    err.code = json.errors[0].extensions?.code;
    throw err;
  }
  return json.data;
}

export const fmtMoney = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
