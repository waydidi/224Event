import { spawnSync } from "node:child_process";
const names = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_STAFF_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "INTERNAL_API_TOKEN",
];
const values = Object.fromEntries(
  names.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
if (Object.keys(values).length) {
  const r = spawnSync("npx", ["wrangler", "secret", "bulk"], {
    input: JSON.stringify(values),
    encoding: "utf8",
  });
  // Never print input or a raw error that might include a secret.
  if (r.status !== 0) throw new Error("Application secret upload failed");
  console.log(`Updated ${Object.keys(values).length} application secrets`);
} else
  console.log(
    "No repository application secrets supplied; existing Worker secrets preserved.",
  );
