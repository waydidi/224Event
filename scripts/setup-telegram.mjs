import { randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";

export const EXPECTED_BOT = "eventbotbirthday_bot";
export const EXPECTED_GROUP = "224 Event";
const BASE = "https://224event.bryank31172.workers.dev";
export function matchingGroups(updates) {
  const candidates = new Map();
  for (const u of updates) {
    const chat =
      u.message?.chat ??
      u.my_chat_member?.chat ??
      u.callback_query?.message?.chat;
    if (
      chat?.title?.normalize("NFKC").replace(/\s+/g, " ").trim() === EXPECTED_GROUP &&
      ["group", "supergroup"].includes(chat.type)
    ) {
      const id = u.message?.migrate_to_chat_id ?? chat.id;
      candidates.set(String(id), { id: String(id), title: chat.title });
    }
  }
  return [...candidates.values()];
}
export function requireUniqueGroup(candidates) {
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? "More than one group is named 224 Event. Set TELEGRAM_STAFF_CHAT_ID to the intended group."
        : "No 224 Event group update is available. Add @eventbotbirthday_bot to 224 Event and send /whoami@eventbotbirthday_bot there, then rerun setup.",
    );
  return candidates[0];
}
export function verifyBotIdentity(bot) {
  if (bot?.username?.toLowerCase() !== EXPECTED_BOT)
    throw new Error(
      "The saved TELEGRAM_BOT_TOKEN belongs to a different bot. Expected @eventbotbirthday_bot.",
    );
}
function wrangler(args, input) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    input,
    encoding: "utf8",
  });
  // Wrangler input can contain credentials. Never echo stdin or raw output.
  if (r.status !== 0) throw new Error(`Cloudflare ${args[0]} operation failed`);
  return r.stdout;
}
async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token)
    throw new Error(
      "Missing GitHub Actions secret TELEGRAM_BOT_TOKEN. Add the @eventbotbirthday_bot token to this repository and rerun setup.",
    );
  async function telegram(method, body = {}) {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(`Telegram ${method} network request failed`);
    }
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(
        `Telegram ${method} failed (HTTP ${response.status}); check bot token and group membership.`,
      );
    return result.result;
  }
  const bot = await telegram("getMe");
  verifyBotIdentity(bot);
  console.log(`Verified bot: @${EXPECTED_BOT}`);
  const webhook = await telegram("getWebhookInfo");
  if (
    webhook.url &&
    webhook.url !== `${BASE}/api/integrations/telegram/webhook`
  )
    throw new Error(
      "This bot already has a webhook for a different app. Use a dedicated bot, or confirm that its existing connection should be replaced.",
    );
  let group;
  if (process.env.TELEGRAM_STAFF_CHAT_ID)
    group = { id: process.env.TELEGRAM_STAFF_CHAT_ID };
  else if (!webhook.url) {
    const updates = await telegram("getUpdates", {
      timeout: 10,
      limit: 100,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    });
    console.log(`Telegram returned ${updates.length} pending update(s).`);
    const seen = new Map();
    for (const update of updates) {
      const candidate = update.message?.chat ?? update.my_chat_member?.chat ?? update.callback_query?.message?.chat;
      if (candidate && ["group", "supergroup"].includes(candidate.type)) seen.set(String(candidate.id), { id: String(candidate.id), title: candidate.title, type: candidate.type });
    }
    console.log("Observed group metadata: " + JSON.stringify([...seen.values()]));
    group = requireUniqueGroup(matchingGroups(updates));
  } else {
    // A prior setup may have connected the webhook without saving chat ID in
    // repository secrets. Read only matching chat metadata, never message text.
    const raw = wrangler([
      "d1",
      "execute",
      "224event-db",
      "--remote",
      "--json",
      "--command",
      `SELECT DISTINCT json_extract(payload,'$.message.chat.id') AS id FROM telegram_inbox WHERE json_extract(payload,'$.message.chat.title')='224 Event' AND json_extract(payload,'$.message.chat.type') IN ('group','supergroup')`,
    ]);
    const rows = JSON.parse(raw)
      .flatMap((x) => x.results ?? [])
      .filter((x) => x.id);
    group = requireUniqueGroup(rows.map((x) => ({ id: String(x.id) })));
  }
  const chat = await telegram("getChat", { chat_id: group.id });
  if (
    chat.title?.normalize("NFKC").replace(/\s+/g, " ").trim() !== EXPECTED_GROUP ||
    !["group", "supergroup"].includes(chat.type)
  )
    throw new Error(
      "The selected chat is not the 224 Event staff group. No settings changed.",
    );
  const membership = await telegram("getChatMember", {
    chat_id: chat.id,
    user_id: bot.id,
  });
  if (
    ["left", "kicked"].includes(membership.status) ||
    membership.can_send_messages === false
  )
    throw new Error(
      "The bot cannot send messages in 224 Event. Allow it to send messages and rerun setup.",
    );
  console.log("Verified staff group: 224 Event");
  const existing = JSON.parse(wrangler(["secret", "list"]));
  const webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    randomBytes(32).toString("base64url");
  console.log(`::add-mask::${webhookSecret}`);
  const values = {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_STAFF_CHAT_ID: String(chat.id),
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  };
  if (process.env.INTERNAL_API_TOKEN)
    values.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
  else if (!existing.some((x) => x.name === "INTERNAL_API_TOKEN"))
    values.INTERNAL_API_TOKEN = randomBytes(32).toString("base64url");
  if (values.INTERNAL_API_TOKEN)
    console.log(`::add-mask::${values.INTERNAL_API_TOKEN}`);
  wrangler(["secret", "bulk"], JSON.stringify(values));
  console.log("Worker Telegram configuration saved.");
  await telegram("setWebhook", {
    url: `${BASE}/api/integrations/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  const info = await telegram("getWebhookInfo");
  if (info.url !== `${BASE}/api/integrations/telegram/webhook`)
    throw new Error("Webhook URL verification failed");
  let ready = false;
  for (let i = 0; i < 15; i++) {
    const response = await fetch(`${BASE}/healthz`);
    const health = await response.json();
    if (health.ok && health.telegramConfigured) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ready)
    throw new Error(
      "Worker Telegram configuration has not become ready yet. Retry setup.",
    );
  const probe = await fetch(`${BASE}/api/integrations/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": webhookSecret,
    },
    body: JSON.stringify({ update_id: -randomInt(1, 2000000000) }),
  });
  if (probe.status !== 200)
    throw new Error("Authenticated Worker webhook test failed");
  await telegram("setMyCommands", {
    scope: { type: "chat", chat_id: chat.id },
    commands: [
      {
        command: "whoami",
        description: "Show your Telegram ID and staff role",
      },
      { command: "tables", description: "Show all tables and session PINs" },
      { command: "open_table", description: "Open a table: /open_table 1" },
      { command: "pin", description: "Issue a new table PIN: /pin 1" },
      { command: "bill", description: "View a table bill: /bill 1" },
      { command: "menu", description: "Show menu availability" },
      { command: "help", description: "Show staff commands" },
    ],
  });
  await telegram("sendMessage", {
    chat_id: chat.id,
    text: "✅ 224 Event notifications are connected.\n\nThis group will receive new orders, Served updates, payment requests, payment confirmations and PDF receipts.\n\nStaff: send /whoami to get your Telegram ID for role registration. Registered cashiers can use /open_table 1 to start a table.",
  });
  console.log(
    "SUCCESS: bot identity, exact staff group, Worker health, authenticated webhook, command menu and test notification verified.",
  );
}
if (process.argv.includes("--apply"))
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
