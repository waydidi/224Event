import { deployedUrl } from "./deployed-url.mjs";
const token = process.env.TELEGRAM_BOT_TOKEN,
  secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (token && secret) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${deployedUrl()}/api/integrations/telegram/webhook`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    },
  );
  const data = await response.json();
  if (!response.ok || !data.ok)
    throw new Error("Telegram webhook registration failed");
  console.log("Telegram webhook registered.");
} else
  console.log(
    "Application secrets absent in repository; existing Telegram webhook configuration preserved.",
  );
