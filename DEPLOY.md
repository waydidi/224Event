# Going live on Cloudflare (domain + app + database in one place)

The whole system runs on Cloudflare: a **Worker** serves the app, one **Durable Object** with built-in **SQLite**
is the database (orders, bills, receipts, Telegram queue), and **orders.224livehouse.com** is attached to the Worker
directly, so there is no DNS record or server to manage. (A Fly.io alternative is kept in `DEPLOY-FLY.md`.)

> **Plan:** use **Workers Paid ($5/month)**. Receipts are generated as PDFs inside the Worker, which needs more CPU
> time per request than the Free plan's 10 ms allows. Everything else would fit the free tier.

## 1. One-time setup (on your computer)
```bash
git clone https://github.com/waydidi/224Event && cd 224Event
npm install
npx wrangler login            # opens the browser: sign in with the Cloudflare account that owns 224livehouse.com
```

## 2. Secrets (typed once, stored encrypted in Cloudflare — never in git)
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # from @BotFather
npx wrangler secret put TELEGRAM_STAFF_CHAT_ID    # the staff group's chat ID (starts with -100…)
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string (e.g. from: openssl rand -hex 24)
npx wrangler secret put INTERNAL_API_TOKEN        # another long random string: your admin password
```
Optional venue details (shown on receipts) can be set as plain variables in `wrangler.jsonc` → `vars`:
`VENUE_ADDRESS_LINES` (use `|` between lines), `VENUE_PHONE`, `VENUE_TAX_ID`.

## 3. Deploy
```bash
npm run cf:deploy
```
Cloudflare creates the database and attaches `orders.224livehouse.com` (the domain must be in this same Cloudflare account).
Open https://orders.224livehouse.com — it works as soon as the certificate is issued (about a minute).

## 4. Set up the venue (no shell needed)
```bash
export ADMIN_URL=https://orders.224livehouse.com
export ADMIN_TOKEN=<the INTERNAL_API_TOKEN you chose>
npm run cf:admin -- tables:ensure 7
npm run cf:admin -- telegram:set-webhook
npm run cf:admin -- telegram:set-commands
npm run cf:admin -- staff:add <telegram-id> cashier "Name"      # each staff member sends /whoami to the bot for their ID
npm run cf:admin -- check
npm run cf:admin -- qr                                            # saves table-qr-codes.pdf — print it
```
Print `table-qr-codes.pdf` (4 table cards per A4 page, 7 cards = 2 pages). Each QR holds the permanent address of one table.

## Day to day
- Staff work entirely in Telegram (open table, PIN, mark served, confirm paid).
- Change a price: `npm run cf:admin -- price:set negroni 380`. Sold out / restock: `/soldout` and `/restock` in Telegram.
- Live logs: `npx wrangler tail`. Backups: Cloudflare keeps the Durable Object's SQLite data redundantly;
  point-in-time restore is available from the dashboard (Workers & Pages → live-house-224 → Durable Objects).

## Testing before going live
```bash
npm test                   # 31 tests against the Node build of the same code
npm run cf:dev             # run the real Cloudflare runtime locally (workerd)
npm run cf:smoke           # end-to-end: QR → join → order → Telegram → served → pay → receipt PDF → Telegram outage retry
```
(See the header of `scripts/cf-smoke.ts` for the exact `wrangler dev` flags the smoke test expects.)
