# Cloudflare Workers / D1

Production entry point: `src/cloudflare/worker.ts`. The original Node server remains
available for local operations and regression tests; it is not bundled in the Worker.
No production credentials are committed.

## Atomicity

D1 does not support an interactive JavaScript transaction. The Worker reads from
primary, builds a write plan, then sends a single transactional `D1.batch` with a
revision compare-and-swap as its first statement. A NOT NULL failure rolls back
the whole batch and reruns validation. Triggers on business tables also advance
the revision, protecting against concurrent operator SQL. Counters, IDs, immutable
order lines, frozen bills, payments, session rollover, audit and outbox rows all
commit together. Retried callbacks never perform external I/O inside a batch plan.
Read-only customer status snapshots are revision-validated too.

This conservative global revision is suited to this event ordering app. Heavy
write contention returns retryable `409 BUSY` after bounded retries. There are no
process-local locks. Use a Workers Paid plan for the higher D1 per-invocation query
limit and CPU budget needed by font embedding and concurrent transactions.

## Local verification (no Cloudflare credentials)

```sh
npm ci
npm run migrations:generate
npx wrangler d1 migrations apply 224event-db --local
npx playwright install --with-deps chromium
npm run check:critical
```

There are 31 original schema/menu migrations plus `0032_worker_runtime.sql` for
revision guards, webhook inbox, delivery leases, rate limits and PDF blobs.
The tests use isolated real workerd/Miniflare D1 databases. Production migrations
are only applied by the deployment job after the complete critical test job passes.
The CI job also verifies generated SQL matches committed SQL.

## Notifications and receipts

Authenticated Telegram webhooks enter a durable inbox before returning 200.
`waitUntil` promptly drains work and a once-per-minute Cron Trigger recovers work
after a crash. A database lease serializes delivery across isolates. Failures use
exponential backoff and Telegram retry_after. Payment remains committed if Telegram
is unavailable. Cards edit the stored message instead of sending another card.

Delivery is at-least-once. Telegram has no send idempotency key: a timeout/crash
between remote delivery and recording its message ID can duplicate a notification
or document. Payment/order uniqueness is independent of that delivery limitation.

Thermal PDF generation uses pdf-lib, embedded Inter fonts and the venue logo, with
80mm/58mm auto-height pages and Code 128 receipt barcodes. PDFs are immutable D1
blobs, separate from payment confirmation, and are served only via random receipt
tokens. Generation retries reuse an existing PDF. No filesystem or R2 is required.

## Deployment and configuration

Push `cloudflare-d1-preparation`. GitHub Actions runs typecheck, the original 30
Node tests, Worker/D1 tests and mobile Playwright tests before it can migrate or
deploy. It uses the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
The final step verifies the live workers.dev URL without creating production orders.

The app additionally requires Worker secrets `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_STAFF_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `INTERNAL_API_TOKEN`.
If supplied as repository secrets, the job syncs them and registers the webhook.
Otherwise existing Worker secrets and webhook settings are preserved. The health
endpoint reports `telegramConfigured`; deployment alone does not invent staff,
prices, tables or Telegram credentials.

Use the authenticated operations API (Bearer `INTERNAL_API_TOKEN`) to configure:

- `POST /api/internal/configure`: `{ "operation":"tables", "count":10 }`
- `POST /api/internal/configure`: `{ "operation":"staff", "telegramUserId":"123", "name":"Cashier", "role":"cashier" }`
- `POST /api/internal/configure`: `{ "operation":"price", "code":"negroni", "priceSatang":22000 }`
- `GET /api/internal/tables`: permanent QR tokens and session state
- `GET /api/internal/menu`: current menu/configured prices
- `POST /api/internal/receipt/generate`: `{ "receiptNumber":"R-000001" }`

QR URLs stay `/t/{permanent_qr_token}`. Customer API paths and Telegram role checks
are preserved. Staff open tables, issue PINs, serve, reopen bills and confirm paid
through Telegram. Prices must all be approved before ordering becomes available.

Before importing an existing Node database, map its `schema_migrations` history to
Wrangler migration history. Do not run seed migrations over an existing populated
schema blindly. This workflow applies normal Wrangler-tracked migrations only.
