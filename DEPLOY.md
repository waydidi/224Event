# Going live: Cloudflare domain + Fly.io

The app is one Node process with a SQLite file, so it runs on Fly.io with a persistent volume.
Cloudflare provides the domain, DNS and HTTPS in front of it. Run everything below on your own computer.
Keep **one** Fly machine only (SQLite must not be shared by two servers).

## 1. Buy the domain
Cloudflare dashboard → **Domains → Registrations** → search, buy (e.g. `224livehouse.com`).

## 2. Create the Fly app
```bash
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth signup                # or: fly auth login   (needs a card)
fly launch --copy-config --no-deploy        # pick a unique app name when asked; keep region sin
fly volumes create data --size 1 --region sin
```
Edit `fly.toml`: set `PUBLIC_BASE_URL = "https://orders.YOURDOMAIN.com"` (or the bare domain).

## 3. Secrets (never put these in git)
```bash
fly secrets set \
  TELEGRAM_BOT_TOKEN=123456:ABC... \
  TELEGRAM_STAFF_CHAT_ID=-100123456789 \
  TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24) \
  VENUE_NAME="224 LIVE HOUSE" \
  VENUE_ADDRESS_LINES="Line 1|Line 2"
```

## 4. Deploy
```bash
fly deploy
fly scale count 1
```

## 5. Point the domain at it
```bash
fly certs add orders.YOURDOMAIN.com        # shows the DNS record to create
```
Cloudflare dashboard → your domain → **DNS → Add record**: `CNAME`, name `orders`, target `<app>.fly.dev`,
proxy **DNS only** (grey cloud) until `fly certs show orders.YOURDOMAIN.com` says the certificate is issued.
Then, if you want Cloudflare's proxy (orange cloud), set **SSL/TLS → Full (strict)**.

## 6. Set up the venue on the live server
```bash
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts tables:ensure 7"
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts telegram:set-webhook"
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts telegram:set-commands"
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts staff:add <telegram-id> cashier \"Name\""
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts check"
```

## 7. QR codes (7 tables)
```bash
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts qr:sheet /data/qr-codes"
fly ssh sftp get /data/qr-codes/table-qr-codes.pdf
```
Print `table-qr-codes.pdf` (4 cards per A4 page). The codes contain the live address and each table's permanent token,
so generate them **after** the domain is final, on the live server.

## Backups
- Fly takes automatic daily snapshots of the volume (`fly volumes snapshots list`).
- Extra safety copy any time (safe while running):
  `fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.ts db:backup /data/backup-$(date +%F).db"`
  then `fly ssh sftp get /data/backup-YYYY-MM-DD.db`.
