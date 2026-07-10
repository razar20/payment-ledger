import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 4000);

const { app } = await createApp();
app.listen(PORT, () => {
  console.log(`Payment Ledger service listening on http://localhost:${PORT}`);
  console.log(`GraphQL endpoint:                    http://localhost:${PORT}/graphql`);
});
