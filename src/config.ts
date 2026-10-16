import path from 'node:path';

export interface Config {
  port: number;
  publicBaseUrl: string;
  trustProxy: boolean;
  dataDir: string;
  databasePath: string;
  displayTimeZone: string;
  telegram: {
    botToken: string;
    staffChatId: string;
    webhookSecret: string;
    apiBase: string;
  };
  internalApiToken: string;
  venue: {
    name: string;
    addressLines: string[];
    phone: string;
    taxId: string;
  };
  receipt: {
    title: string;
    widthMm: 80 | 58;
    customerDownload: boolean;
  };
  billing: {
    serviceChargeBps: number;
    vatBps: number;
    paymentMethods: string[];
  };
  access: {
    visitTokenTtlHours: number;
    pinMaxFailedAttempts: number;
  };
  outbox: {
    pollIntervalMs: number;
    maxBackoffMs: number;
  };
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Config ${name} must be a non-negative integer`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function list(value: string | undefined, sep: string, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value.split(sep).map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const width = int(env.RECEIPT_WIDTH_MM, 80, 'RECEIPT_WIDTH_MM');
  if (width !== 80 && width !== 58) throw new Error('RECEIPT_WIDTH_MM must be 80 or 58');
  const methods = list(env.PAYMENT_METHODS, ',', ['Cash', 'PromptPay']);
  if (methods.length === 0 || methods.length > 4) throw new Error('PAYMENT_METHODS must list 1-4 methods');

  const config: Config = {
    port: int(env.PORT, 3000, 'PORT'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir,
    databasePath: env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, '224.db'),
    displayTimeZone: env.DISPLAY_TIMEZONE || 'Asia/Bangkok',
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || '',
      staffChatId: (env.TELEGRAM_STAFF_CHAT_ID || '').trim(),
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
      apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    },
    internalApiToken: env.INTERNAL_API_TOKEN || '',
    venue: {
      name: env.VENUE_NAME || '224 LIVE HOUSE',
      addressLines: list(env.VENUE_ADDRESS_LINES, '|', []),
      phone: env.VENUE_PHONE || '',
      taxId: env.VENUE_TAX_ID || '',
    },
    receipt: {
      title: env.RECEIPT_TITLE || 'SALES RECEIPT',
      widthMm: width,
      customerDownload: bool(env.RECEIPT_CUSTOMER_DOWNLOAD, true),
    },
    billing: {
      serviceChargeBps: int(env.SERVICE_CHARGE_BPS, 0, 'SERVICE_CHARGE_BPS'),
      vatBps: int(env.VAT_BPS, 0, 'VAT_BPS'),
      paymentMethods: methods,
    },
    access: {
      visitTokenTtlHours: int(env.VISIT_TOKEN_TTL_HOURS, 12, 'VISIT_TOKEN_TTL_HOURS') || 12,
      pinMaxFailedAttempts: int(env.PIN_MAX_FAILED_ATTEMPTS, 10, 'PIN_MAX_FAILED_ATTEMPTS') || 10,
    },
    outbox: {
      pollIntervalMs: int(env.OUTBOX_POLL_INTERVAL_MS, 1000, 'OUTBOX_POLL_INTERVAL_MS') || 1000,
      maxBackoffMs: int(env.OUTBOX_MAX_BACKOFF_MS, 5 * 60_000, 'OUTBOX_MAX_BACKOFF_MS') || 300_000,
    },
  };
  return { ...config, ...overrides };
}
