# 224 Live House — QR Cocktail Ordering

A mobile-first cocktail ordering system for 224 Live House events.

- Each table has one **permanent QR code**. Guests scan it, enter a **table PIN** from staff, then order. Everyone at the table puts their orders on **one shared bill**.
- Staff work only in a **private Telegram group**. Orders show up as cards with a **Mark as Served** button. Payment requests show up as cards with **Confirm Paid** buttons.
- When a cashier confirms payment, the system closes the session and makes an **80 mm (or 58 mm) thermal-style PDF receipt**. It posts the PDF to the staff group, and the guest can download it too.
- The same QR code works for the next group. Rounds are numbered `TABLE1-1`, `TABLE1-2`, …, and each one is kept separately.

There is no admin dashboard. Operators set things up with a CLI (`npm run admin -- …`). Staff use Telegram commands and buttons.

---

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 22.18. TypeScript runs directly through Node's built-in type stripping, so there's no build step. |
| Database | SQLite through the built-in `node:sqlite`, in WAL mode. Writes use `BEGIN IMMEDIATE` transactions. |
| HTTP | `node:http` with a small router, security headers, a strict CSP, rate limits and body-size limits |
| Frontend | Vanilla JS and CSS in `public/`. No framework, no build step, no inline scripts. |
| PDF | `pdfkit` (receipts, QR print sheet). `qrcode` draws the QR codes. |
| Tests | `node:test` (`npm test`) |

Runtime dependencies: `pdfkit` and `qrcode`.

## Quick start (development)

```bash
npm install
cp .env.example .env                 # fill in values (see Configuration)
npm run admin -- tables:ensure 10    # create tables 1..10, each with a permanent QR token
npm run admin -- price:set negroni 220   # …repeat for all 18 items, or use price:import
npm run admin -- staff:add 123456789 cashier "Somchai"
npm start                            # http://localhost:3000
npm test                             # acceptance + resilience tests
npm run typecheck
```

`npm run admin` with no arguments lists every command.

## Going live checklist (spec §15)

1. **Prices.** Every one of the 18 cocktails needs an approved price. **Ordering stays disabled until they all have one.** The menu is seeded with `NULL` prices on purpose. Set them with:
   ```bash
   npm run admin -- price:import prices.json   # { "lost-cherry": 280, "negroni": 220, ... }  (THB)
   npm run admin -- menu:list
   ```
   Optional details per item: `npm run admin -- item:update lost-cherry --image https://… --description "…"`.
2. **Tables and QR codes.** Run `npm run admin -- tables:ensure <N>`, then `npm run admin -- qr:sheet ./qr-codes`. This writes a printable A4 PDF (4 cards per page) and one PNG per table. Set `PUBLIC_BASE_URL` before printing, because the QR codes contain that URL.
3. **Telegram:**
   1. Create a bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
   2. Add the bot to the private staff group. To find the group's chat ID, temporarily disable privacy mode or use `getUpdates`, then set `TELEGRAM_STAFF_CHAT_ID`.
   3. Set `TELEGRAM_WEBHOOK_SECRET` to a random string.
   4. Run `npm run admin -- telegram:set-webhook` and `npm run admin -- telegram:set-commands`.
4. **Staff.** Each staff member sends `/whoami` to the bot to get their numeric ID. Then register them:
   `npm run admin -- staff:add <id> server|cashier|lead "Display name"`.
5. **Receipt logo.** Save the venue logo as `assets/receipt-logo.png` (black on white works best on thermal paper), or point `RECEIPT_LOGO_PATH` at it. Until then the receipt prints a plain "224" mark.
6. **Venue and receipts.** Set `VENUE_*`, `RECEIPT_*`, `PAYMENT_METHODS`, `SERVICE_CHARGE_BPS` and `VAT_BPS`. Leave the charges at 0 unless they really apply; the system never invents charges.
7. Run `npm run admin -- check`. It exits non-zero until everything above is in place.

## Staff procedure (Telegram)

| Step | Who | How |
|---|---|---|
| Seat a group | cashier/lead | `/open_table 1`. The bot posts **TABLE 1 OPENED · TABLE1-N · Join PIN 123456**. Tell the guests the PIN in person. |
| Guest lost the PIN, or someone outside the group got it | cashier/lead | `/pin 1` or the **🔁 New PIN** button. Guests who already joined stay joined. Too many wrong PIN attempts also lock joining until a new PIN is issued. |
| New order arrives | everyone | A card appears with **✅ Mark as Served**. Tap it once the drinks reach the table. |
| Guests tap *Confirm & Request Payment* | everyone | A **🧾 PAYMENT REQUESTED** card appears with the itemised bill and the total to collect. New orders are paused. |
| Money collected (cash or manual PromptPay) | cashier/lead | Tap **✅ Confirm Paid · Cash** or **· PromptPay**. **Only after you have actually checked the money.** The card changes to PAID, the PDF receipt is posted, and the table is freed. |
| Guests want more drinks after requesting the bill | cashier/lead | **↩️ Reopen bill**, or `/reopen_bill 1`. The frozen bill is cancelled (and audited). The guests' next payment request creates a fresh bill. |
| Next group | cashier/lead | **▶️ Open TABLE1-2** on the paid card, or `/open_table 1`. |
| Group left without ordering | cashier/lead | `/close_table 1` (only works if the session has no orders) |
| Walk-out or other recovery | lead | `/void_table 1 CONFIRM reason`. Orders are kept and the session is marked VOIDED (unpaid). Paid sessions can never be voided. |
| Item ran out | cashier/lead | `/soldout Negroni` and `/restock Negroni` |
| Overview | everyone | `/tables`, `/bill 1`, `/menu`, `/help` |

Roles: **server** can mark orders served and view things. **cashier** can also open tables, issue PINs, reopen bills, confirm payments and change availability. **lead** can also void sessions. Being a member of the group gives no permissions on its own: every button press and command is checked against the `staff` table.

## How the spec's security requirements are met

- **The QR is not proof of membership.** The QR identifies only the table. Joining needs the current round's 6-digit PIN, which staff give out in person. Joining returns a random visit token, stored hashed in `session_access`. The token is bound to **one** session and expires (12 h by default). It is sent as a `Bearer` header rather than a cookie, so CSRF doesn't apply. A browser tab from an earlier round can still see *its own* paid session and receipt. It cannot order in, view or act on the new round; those requests return `410 SESSION_ENDED`.
- **Wrong PINs are limited.** Failed attempts are counted per session and lock out after `PIN_MAX_FAILED_ATTEMPTS`. Joining is also rate-limited per IP.
- **The server never trusts client prices, totals or status.** Orders carry only item IDs and quantities. The server snapshots names and prices into `order_items`. A database trigger makes order lines immutable, and `CHECK` constraints enforce the arithmetic. The total the customer saw is sent back and compared. If prices changed in the meantime, the order is rejected with `PRICE_CHANGED`. Payment requests work the same way: they carry the reviewed total and order count, and the server rejects them with `BILL_CHANGED` if another guest ordered in between.
- **Idempotency:**
  - Orders: `UNIQUE(session_id, idempotency_key)` plus a hash of the request (a reused key with different content is rejected).
  - Payments: a bill-scoped key plus a partial unique index allowing one CONFIRMED payment per bill.
  - Served taps: a conditional `UPDATE … WHERE status='NEW'`.
  - Telegram retries the same update: `telegram_updates(update_id)`.
- **Transactions.** Payment requests, payment confirmation, opening a session and voiding all run in one `BEGIN IMMEDIATE` transaction each. Sessions have `UNIQUE(table_id, round_number)` and a partial unique index allowing **one active session per table**.
- **Telegram.** The webhook checks `X-Telegram-Bot-Api-Secret-Token` with a constant-time comparison. It also checks the chat ID (actions only work in the staff group) and the user's active staff role. `callback_data` is an opaque random reference (`a:<20 chars>`) into `callback_actions`; it never contains prices or state. Callbacks are answered straight away, and cards are always re-rendered from the database.
- **Reliable delivery.** Every notification is written to `outbox_events` **in the same transaction** as the change that caused it. A worker delivers them with exponential backoff and honours Telegram's `retry_after`. Card delivery is "sync to the current state" (send if it was never sent, otherwise edit), so retries and out-of-order delivery are safe. Bot tokens are removed from logged and stored errors.
- **Receipts.** The receipt number and lookup token are allocated in the payment transaction. The PDF is built only from the frozen bill and the recorded payment, so regenerating it (CLI `receipt:regenerate`, or `POST /api/internal/receipt/generate` with `INTERNAL_API_TOKEN`) never touches money or session history. Customers download receipts through a 32-character random token; no sequential IDs are exposed. The title defaults to "SALES RECEIPT". Nothing is labelled a tax invoice.
- **Audit.** `audit_events` is append-only, enforced by triggers. It records joins, failed PINs, orders, served taps, payment requests, reopens, payments, voids, price and availability changes, and unauthorised attempts.
- **HTTP hardening.** Security headers are set: strict CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`. Request bodies are size-limited, POSTs must be `application/json`, and requests are rate-limited per IP and per visit token.

## API

```
GET  /api/public/table/:qrToken           table + whether a session is open (no session secrets)
GET  /api/public/menu                     categories/items/prices, orderingEnabled
POST /api/public/session/join             { qrToken, pin } -> { visitToken }
POST /api/public/orders                   Bearer; { items:[{menuItemId,quantity}], notes, idempotencyKey, expectedTotalSatang }
GET  /api/public/session/orders           Bearer
GET  /api/public/session/bill             Bearer; live draft, or the frozen bill once requested
POST /api/public/session/request-payment  Bearer; { expectedTotalSatang, expectedOrderCount }
GET  /api/public/session/status           Bearer; everything the UI polls (every 5 s)
GET  /api/public/receipt/:secureToken     PDF (if RECEIPT_CUSTOMER_DOWNLOAD=true)
POST /api/integrations/telegram/webhook   Telegram only (secret header)
POST /api/internal/receipt/generate       Bearer INTERNAL_API_TOKEN; { receiptNumber, resend? }
GET  /healthz                             liveness + outbox backlog (use for monitoring)
```

State machines (spec §6), plus the deliberate recovery state `VOIDED`:

```
Table:   AVAILABLE -> OCCUPIED -> AVAILABLE
Session: OPEN <-> PAYMENT_REQUESTED -> PAID_CLOSED      (OPEN|PAYMENT_REQUESTED -> VOIDED: lead only)
Order:   NEW -> SERVED
Bill:    DRAFT (computed live) -> REQUESTED -> PAID      (REQUESTED -> CANCELLED on reopen)
```

## Data model

`src/db/migrations.ts` holds the full schema. It covers every table in spec §8. It adds:
- `bill_lines`: a frozen snapshot of the bill, which the receipt is built from.
- `callback_actions`: opaque Telegram button references.
- `telegram_updates`: webhook de-duplication.
- `counters`: `ORD-0001`, `BILL-0001` and `R-000001` numbering.

Money is always stored as an integer number of satang.

## Tests (spec §13)

`npm test` runs the acceptance suite against a real HTTP server, an in-memory database and a fake Telegram API.

| Spec test | Covered in |
|---|---|
| 1–13 | `test/acceptance.test.ts`, one test per item, in order |
| 14 Telegram outage | `test/resilience.test.ts` (orders survive, retries deliver once, receipt resend) |
| 16 Prices required | `test/resilience.test.ts` |
| 15 Device tests | Manual on real iOS Safari and Android Chrome. The UI was also checked in headless Chromium at 390×844 through the full flow. |

There are extra tests for PIN lockout, token expiry, close/void, sold-out items, duplicate webhook deliveries, configured service charge/VAT, path traversal and security headers.

## Deployment notes

- Run a **single instance**, because the rate limiter and outbox worker live in-process. Put it behind an HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) and set `TRUST_PROXY=true`.
- Persist `DATA_DIR`. It holds the SQLite database and the receipt PDFs. Back up `224.db` (use `sqlite3 224.db ".backup …"`) and `receipts/`. Keep these for as long as your financial records must be retained.
- Watch `/healthz`. A growing `outboxPending` or an old `outboxOldest` means Telegram delivery is failing. `npm run admin -- outbox:status` shows the errors.
- Physical printing is out of scope. The PDF is sized for 80 mm (or 58 mm) rolls and can be printed by hand or through a printer bridge.

## Out of scope (v1)

Admin dashboard, online card or PromptPay reconciliation, split bills, inventory, automatic printing, customer accounts.
