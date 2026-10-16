import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { menuReadiness } from './domain/menu.ts';
import { consoleLogger } from './lib/log.ts';

const config = loadConfig();
const app = createApp(config);
const log = consoleLogger;

const readiness = menuReadiness(app.ctx.db);
if (!readiness.ready) log.warn('Ordering is DISABLED until all menu prices are configured', { missing: readiness.missing });
if (!config.telegram.botToken || !config.telegram.staffChatId) log.warn('Telegram is not configured; notifications will queue in the outbox');
if (!config.telegram.webhookSecret) log.warn('TELEGRAM_WEBHOOK_SECRET is not set; the webhook will reject all updates');

app.worker.start();
app.server.listen(config.port, () => log.info('224 Live House ordering server listening', { port: config.port, base: config.publicBaseUrl }));

const shutdown = async (signal: string) => {
  log.info('shutting down', { signal });
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
