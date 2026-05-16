import { config } from '../config.js';

type TelegramMethod = 'getUpdates' | 'sendMessage' | 'setMyCommands';

type ReplyKeyboardMarkup = {
  keyboard: string[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
};

type ReplyKeyboardRemove = {
  remove_keyboard: true;
};

type SendMessageOptions = {
  replyMarkup?: ReplyKeyboardMarkup | ReplyKeyboardRemove;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

async function telegramRequest<T>(method: TelegramMethod, body: Record<string, unknown>): Promise<T> {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`telegram_http_${response.status}`);
  }

  const data = await response.json() as { ok: boolean; result: T; description?: string };
  if (!data.ok) {
    throw new Error(data.description ?? 'telegram_api_error');
  }

  return data.result;
}

export async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return telegramRequest('getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['message']
  });
}

export async function sendMessage(chatId: number | string, text: string, options?: SendMessageOptions): Promise<void> {
  await telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: options?.replyMarkup
  });
}

export async function setCommands(): Promise<void> {
  await telegramRequest('setMyCommands', {
    commands: [
      { command: 'start', description: 'Create wallet and begin setup' },
      { command: 'menu', description: 'Open the main menu keyboard' },
      { command: 'help', description: 'Show setup and usage guide' },
      { command: 'wallet', description: 'Show wallet and funding details' },
      { command: 'enable', description: 'Enable auto-buy' },
      { command: 'disable', description: 'Disable auto-buy' },
      { command: 'enableexit', description: 'Enable auto-sell exits' },
      { command: 'disableexit', description: 'Disable auto-sell exits' },
      { command: 'settings', description: 'Show current settings' },
      { command: 'setsize', description: 'Set buy size in SOL' },
      { command: 'setstake', description: 'Set stake size in SOL' },
      { command: 'setdaily', description: 'Set daily buy limit in SOL' },
      { command: 'setminscore', description: 'Set minimum signal score' },
      { command: 'degenmode', description: 'Apply fast-entry degen preset' },
      { command: 'turboon', description: 'Enable turbo safety guards' },
      { command: 'turbooff', description: 'Disable turbo safety guards' },
      { command: 'turbostatus', description: 'Show turbo safety status' },
      { command: 'settp', description: 'Set take profit percent' },
      { command: 'setsl', description: 'Set stop loss percent' },
      { command: 'setslippage', description: 'Set slippage in bps' },
      { command: 'setpriority', description: 'Set priority fee in SOL' },
      { command: 'subscribe', description: 'Set allowed signal sources' },
      { command: 'sources', description: 'Show current signal source setup' },
      { command: 'sniper', description: 'Show sniper source and filter status' },
      { command: 'trade', description: 'Enter a manual trade' },
      { command: 'buy', description: 'Alias for manual trade' },
      { command: 'positions', description: 'Show open and closing positions' },
      { command: 'copytrade', description: 'Copy-trade setup and status' },
      { command: 'status', description: 'Show recent orders' },
      { command: 'deposits', description: 'Show deposit history' },
      { command: 'withdraw', description: 'Request withdrawal' },
      { command: 'confirmwithdraw', description: 'Confirm pending withdrawal code' },
      { command: 'withdrawwizard', description: 'Step-by-step withdrawal flow' },
      { command: 'withdrawals', description: 'Show withdrawal requests' },
      { command: 'report', description: 'Show account summary' },
      { command: 'whytrade', description: 'Explain the latest trade decision' },
      { command: 'exportkey', description: 'Reveal private key' },
      { command: 'close', description: 'Hide the menu keyboard' }
    ]
  });
}
