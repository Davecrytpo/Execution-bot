import { readFile } from 'node:fs/promises';
import { config } from '../config.js';

type TelegramMethod =
  | 'getUpdates'
  | 'sendMessage'
  | 'sendPhoto'
  | 'editMessageText'
  | 'answerCallbackQuery'
  | 'setMyCommands'
  | 'deleteWebhook'
  | 'setWebhook';

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramChat = {
  id: number;
};

export type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
};

export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

type ReplyKeyboardMarkup = {
  keyboard: string[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
};

type ReplyKeyboardRemove = {
  remove_keyboard: true;
};

type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;

type SendMessageOptions = {
  replyMarkup?: ReplyMarkup;
};

type SendPhotoOptions = {
  caption?: string;
  replyMarkup?: ReplyMarkup;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: TelegramUser;
    message?: TelegramMessage;
  };
};

async function parseTelegramResponse<T>(response: Response) {
  const raw = await response.text();
  let data: { ok?: boolean; result?: T; description?: string } = {};

  if (raw) {
    try {
      data = JSON.parse(raw) as { ok?: boolean; result?: T; description?: string };
    } catch {
      data = {};
    }
  }

  if (!response.ok || !data.ok) {
    throw new Error(data.description ?? `telegram_http_${response.status}`);
  }

  return data.result as T;
}

async function telegramRequest<T>(method: TelegramMethod, body: Record<string, unknown>): Promise<T> {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return parseTelegramResponse<T>(response);
}

export async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return telegramRequest('getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['message', 'callback_query']
  });
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  options?: SendMessageOptions
): Promise<TelegramMessage> {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: options?.replyMarkup
  });
}

export async function sendPhoto(
  chatId: number | string,
  photoPath: string,
  options?: SendPhotoOptions
): Promise<TelegramMessage> {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const photo = await readFile(photoPath);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('photo', new Blob([photo]), photoPath.split(/[\\/]/).pop() ?? 'image.png');

  if (options?.caption) {
    form.set('caption', options.caption);
  }

  if (options?.replyMarkup) {
    form.set('reply_markup', JSON.stringify(options.replyMarkup));
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
    method: 'POST',
    body: form
  });

  return parseTelegramResponse<TelegramMessage>(response);
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  options?: SendMessageOptions
): Promise<TelegramMessage> {
  return telegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    reply_markup: options?.replyMarkup
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

export async function setCommands(): Promise<void> {
  await telegramRequest('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open your trading dashboard' },
      { command: 'menu', description: 'Open the main dashboard' },
      { command: 'wallet', description: 'Open wallet overview' },
      { command: 'trade', description: 'Start a manual trade flow' },
      { command: 'status', description: 'Open analytics and recent activity' },
      { command: 'help', description: 'Show onboarding and support help' },
      { command: 'close', description: 'Hide the dashboard' }
    ]
  });
}

export async function deleteWebhook(dropPendingUpdates = false): Promise<void> {
  await telegramRequest('deleteWebhook', {
    drop_pending_updates: dropPendingUpdates
  });
}

export async function setWebhook(url: string, secretToken?: string): Promise<void> {
  await telegramRequest('setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query'],
    ...(secretToken ? { secret_token: secretToken } : {})
  });
}
