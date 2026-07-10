import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createYoga, createSchema } from 'graphql-yoga';
import { createDb } from './db.js';
import { createLedger } from './ledger.js';
import { createInvoiceService } from './invoices.js';
import { typeDefs } from './schema.js';
import { createResolvers } from './resolvers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the full app. dbPath is injectable so tests can use ':memory:'. */
export async function createApp({ dbPath } = {}) {
  const db = createDb(dbPath);
  const ledger = createLedger(db);
  const invoices = createInvoiceService(db, ledger);

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers: createResolvers({ ledger, invoices }) }),
    graphqlEndpoint: '/graphql',
    landingPage: false,
    maskedErrors: false,
  });

  const app = express();
  app.use(yoga.graphqlEndpoint, yoga);
  app.get('/health', (_req, res) => res.json({ ok: true, ledgerBalanced: ledger.isBalanced() }));

  // Serve the built React client, if present (single-service hosting).
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!graphql|health).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  return { app, db, ledger, invoices };
}
