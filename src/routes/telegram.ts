import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { handleIncomingUpdate } from '../bot/telegramBot.js';
import type { TelegramUpdate } from '../lib/telegram.js';

export const telegramRouter = Router();

telegramRouter.post('/webhook', async (req, res) => {
  if (!config.telegramWebhookUrl) {
    return res.status(404).json({ error: 'telegram_webhook_disabled' });
  }

  if (config.telegramWebhookSecret) {
    const header = req.header('x-telegram-bot-api-secret-token');
    if (header !== config.telegramWebhookSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    await handleIncomingUpdate(req.body as TelegramUpdate);
    return res.json({ ok: true });
  } catch (error: any) {
    logger.error('telegram_webhook_update_failed', { message: error.message });
    return res.status(500).json({ error: 'telegram_webhook_update_failed' });
  }
});
