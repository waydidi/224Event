# Cloudflare Workers / D1 migration (in progress)

This branch records the confirmed D1 binding `DB` for `224event-db`.
**It is not ready for production deployment.** The existing app uses
`node:http`, synchronous `node:sqlite`, in-process workers, and PDFKit.

## Preparing database migrations

Run on your own machine with Node.js >=22.18:

```sh
npm install
node scripts/export-d1-migrations.mjs
npx wrangler d1 migrations apply 224event-db --local
```

The generator exports all SQL migrations in `src/db/migrations.ts` in order.
Review the resulting SQL and verify it with D1 locally before attempting remote application.
Do not import production data or migrate your live D1 database until all checks pass.
Wrangler tracks its own migration history; the existing application's
`schema_migrations` table is not automatically mapped to it.

## Required before going live

1. Port the HTTP server and static assets to the Workers request handler.
2. Rewrite the database layer to asynchronous D1 calls, including domain callers.
3. Rework multi-statement payment/order/session operations so their atomicity and
   idempotency guarantees survive D1. Do not simply replace `tx()` with a series
   of awaited independent writes.
4. Replace the in-process notification polling with a Workers-compatible
   scheduled/queue delivery mechanism and test Telegram retries.
5. Port receipt generation or use a separate Node receipt service; verify PDF
   output and its storage/retrieval behavior.
6. Run end-to-end tests (QR/PIN, ordering, served, bill freeze, payment,
   receipt, next round), including simultaneous requests.
7. Only then deploy to Workers and apply reviewed D1 migrations remotely.

Cloudflare credentials belong in Worker secrets, not in Git.
