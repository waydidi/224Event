import { redact } from '../lib/log.ts';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramClient {
  readonly configured: boolean;
  call<T = any>(method: string, params: Record<string, unknown>): Promise<T>;
  sendDocument(chatId: string, filename: string, data: Uint8Array, caption: string): Promise<{ message_id: number }>;
}

export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;
  readonly retryAfterSec: number | undefined;
  constructor(method: string, status: number, description: string, retryAfterSec?: number) {
    super(redact(`Telegram ${method} failed (${status}): ${description}`));
    this.status = status;
    this.description = description;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Minimal Bot API client. The token never appears in errors or logs. */
export class HttpTelegramClient implements TelegramClient {
  private readonly base: string;
  readonly configured: boolean;
  private readonly timeoutMs: number;

  constructor(apiBase: string, token: string, timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs;
    this.base = `${apiBase}/bot${token}`;
    this.configured = !!token;
  }

  private async post<T>(method: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    if (!this.configured) throw new TelegramError(method, 0, 'bot token not configured');
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, { method: 'POST', body, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new TelegramError(method, 0, redact((err as Error).message));
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !json.ok) throw new TelegramError(method, res.status, json.description ?? res.statusText, json.parameters?.retry_after);
    return json.result as T;
  }

  call<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.post<T>(method, JSON.stringify(params), { 'content-type': 'application/json' });
  }

  sendDocument(chatId: string, filename: string, data: Uint8Array, caption: string) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    form.set('document', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), filename);
    return this.post<{ message_id: number }>('sendDocument', form);
  }
}

export const keyboard = (rows: { text: string; actionId: string }[][]) =>
  rows.length ? { inline_keyboard: rows.map((r) => r.map((b): InlineButton => ({ text: b.text, callback_data: `a:${b.actionId}` }))) } : { inline_keyboard: [] };
