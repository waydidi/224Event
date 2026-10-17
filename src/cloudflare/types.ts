export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_STAFF_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  INTERNAL_API_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  [key: string]: unknown;
}
