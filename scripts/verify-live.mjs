import assert from "node:assert/strict";
import { writeFileSync, appendFileSync } from "node:fs";
import { deployedUrl } from "./deployed-url.mjs";
const url = deployedUrl();
async function request(path, init) {
  // Worker code and asset routing metadata can propagate at different times.
  // Never follow a redirect: wait for a direct success, or fail the check.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url + path, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const transient =
      (!init?.method || init.method === "GET") &&
      ((response.status >= 300 && response.status < 400) ||
        response.status >= 500);
    if (!transient || attempt >= 14) return response;
    console.log(`Waiting for ${path}: HTTP ${response.status}`);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

let health;
for (let i = 0; i < 5; i++) {
  const r = await request("/healthz");
  if (r.ok) {
    health = await r.json();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
assert.equal(health?.ok, true);
assert.equal(health.runtime, "cloudflare-workers");
assert.equal(health.database, "d1");
const menu = await request("/api/public/menu");
assert.equal(menu.status, 200);
assert.ok((await menu.json()).categories.length > 0);
const homepage = await request("/");
assert.equal(homepage.status, 200);
assert.match(await homepage.text(), /224 Live House/);
const qrShell = await request("/t/LiveVerificationQrShell");
assert.equal(qrShell.status, 200);
assert.match(await qrShell.text(), /224 Live House/);
for (const asset of [
  "/static/app.js",
  "/static/styles.css",
  "/static/logo-224-header.webp",
])
  assert.equal((await request(asset)).status, 200);
assert.equal((await request("/api/internal/tables")).status, 401);
assert.equal(
  (
    await request("/api/integrations/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).status,
  health.telegramConfigured ? 401 : 503,
);
writeFileSync(
  "live-verification.json",
  JSON.stringify(
    {
      url,
      verifiedAt: new Date().toISOString(),
      health,
      checks: [
        "D1 health",
        "menu",
        "HTML and QR shell without redirects",
        "JS/CSS/image assets",
        "internal authentication",
        "webhook authentication",
      ],
    },
    null,
    2,
  ) + "\n",
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Deployed and verified\n\n${url}\n\n- Database: D1\n- Telegram configured: ${health.telegramConfigured}\n- Menu ready: ${health.menuReady}\n`,
  );
console.log(`Verified ${url}`);
console.log(
  `Telegram configured: ${health.telegramConfigured}; menu ready: ${health.menuReady}`,
);
