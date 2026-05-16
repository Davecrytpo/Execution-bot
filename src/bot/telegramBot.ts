import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { sendMessage, setCommands, getUpdates, type TelegramUpdate } from '../lib/telegram.js';
import {
  createWithdrawalRequest,
  getDepositHistory,
  exportWalletSecret,
  getLatestDecisionReason,
  getOpenPositions,
  getOrCreateWallet,
  getRecentOrders,
  getUserSettings,
  getWalletBalance,
  getWithdrawalHistory,
  updateUserSettings
} from '../services/custodyService.js';
import { enqueueManualTradeForUser } from '../services/executionService.js';
import { logger } from '../lib/logger.js';
import { logAuditAction } from '../lib/audit.js';
import { isValidPositiveSolAmount } from './wizardLogic.js';

const MIN_BUY_SOL = 0.005;
const DEGEN_MIN_SCORE = 18;
const DEGEN_DAILY_LIMIT_SOL = 0.15;
const DEGEN_SLIPPAGE_BPS = 500;
const DEGEN_PRIORITY_SOL = 0.0002;
const TURBO_MAX_OPEN_POSITIONS_PER_SOURCE = 3;
const TURBO_TOKEN_COOLDOWN_MINUTES = 10;
const TURBO_DUPLICATE_WINDOW_SECONDS = 90;

type WithdrawWizardState = {
  step: 'awaiting_destination' | 'awaiting_amount';
  destination?: string;
};

const withdrawWizardStateByChat = new Map<number, WithdrawWizardState>();
const pendingWithdrawConfirmByChat = new Map<number, {
  code: string;
  destination: string;
  amount: number;
  expiresAt: number;
  userId: string;
  walletId: string;
}>();

const MAIN_MENU = [
  ['💼 Positions', '🎯 LP Sniper'],
  ['🤖 Copy Trade', '🐤 Twitter'],
  ['🏦 Wallet', '⚙️ Settings'],
  ['✅ Enable Auto-Buy', '🛑 Disable Auto-Buy'],
  ['📥 Deposits', '💸 Withdraw'],
  ['📤 Withdrawals', '📊 Report'],
  ['🧠 Why This Token', '🔄 Refresh'],
  ['🧾 Help', '🗑 Close']
];

const MENU_TO_COMMAND: Record<string, string> = {
  '💼 positions': '/positions',
  '🎯 lp sniper': '/help',
  '🤖 copy trade': '/copytrade',
  '🐤 twitter': '/subscribe',
  '🏦 wallet': '/wallet',
  '⚙️ settings': '/settings',
  '✅ enable auto-buy': '/enable',
  '🛑 disable auto-buy': '/disable',
  '📥 deposits': '/deposits',
  '💸 withdraw': '/withdrawwizard',
  '📤 withdrawals': '/withdrawals',
  '📊 report': '/report',
  '🧠 why this token': '/whytrade',
  '🔄 refresh': '/menu',
  '🧾 help': '/help',
  '🗑 close': '/close'
};

async function audit(identity: { walletContext: { userId: string }; chatId: number }, action: string, metadata?: Record<string, unknown>) {
  await logAuditAction({
    userId: identity.walletContext.userId,
    chatId: identity.chatId,
    action,
    metadata
  });
}

function newWithdrawCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function showMainMenu(chatId: number | string) {
  await sendMessage(
    chatId,
    [
      '*Main Menu*',
      'Use the buttons below or keep using `/` commands.',
      'For manual buy: `/trade TOKEN_MINT 0.05 300 75 20`.'
    ].join('\n'),
    {
      replyMarkup: {
        keyboard: MAIN_MENU,
        resize_keyboard: true,
        input_field_placeholder: 'Choose an action or type /help'
      }
    }
  );
}

async function getIdentity(update: TelegramUpdate) {
  const from = update.message?.from;
  const chatId = update.message?.chat.id;
  if (!from || !chatId) {
    return null;
  }

  return {
    from,
    chatId,
    walletContext: await getOrCreateWallet({
      telegramUserId: from.id,
      chatId,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name
    })
  };
}

function getCommandAndArgs(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (trimmed.startsWith('/')) {
    const [command, ...args] = trimmed.split(/\s+/);
    return { command: command.toLowerCase(), args };
  }

  const commandFromMenu = MENU_TO_COMMAND[trimmed.toLowerCase()];
  if (commandFromMenu) {
    return { command: commandFromMenu, args: [] };
  }

  return { command: '', args: [] };
}

async function handleStart(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const { chatId, walletContext } = identity;
  const lines = [
    '*Execution Bot Ready*',
    `Wallet: \`${walletContext.wallet.public_key}\``,
    'Fund this wallet with SOL, then enable auto-buy with `/enable`.',
    'Open the action keyboard anytime with `/menu`.'
  ];

  if (walletContext.exportedKey) {
    lines.push('');
    lines.push('*Save this private key now.*');
    lines.push('You may not be able to recover the wallet later without it.');
    lines.push(`Private key (base64): \`${walletContext.exportedKey}\``);
  }

  await sendMessage(chatId, lines.join('\n'));
  await showMainMenu(chatId);
}

async function handleMenu(update: TelegramUpdate) {
  const chatId = update.message?.chat.id;
  if (!chatId) {
    return;
  }
  await showMainMenu(chatId);
}

async function handleClose(update: TelegramUpdate) {
  const chatId = update.message?.chat.id;
  if (!chatId) {
    return;
  }

  withdrawWizardStateByChat.delete(chatId);
  pendingWithdrawConfirmByChat.delete(chatId);
  await sendMessage(chatId, 'Menu hidden. Send `/menu` to open it again.', {
    replyMarkup: { remove_keyboard: true }
  });
}

async function handleWallet(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const { chatId, walletContext } = identity;
  const balance = await getWalletBalance(walletContext.wallet.public_key).catch(() => null);
  await sendMessage(
    chatId,
    [
      '*Wallet*',
      `Address: \`${walletContext.wallet.public_key}\``,
      `Balance: \`${balance === null ? 'unavailable' : `${balance} SOL`}\``,
      'Use `/exportkey CONFIRM` only when you really need to reveal the secret again.'
    ].join('\n')
  );
}

async function handleEnable(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { autoBuyEnabled: true });
  await audit(identity, 'settings.auto_buy_enabled', { value: true });
  await sendMessage(identity.chatId, 'Auto-buy enabled.');
}

async function handleDisable(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { autoBuyEnabled: false });
  await audit(identity, 'settings.auto_buy_enabled', { value: false });
  await sendMessage(identity.chatId, 'Auto-buy disabled.');
}

async function handleEnableExit(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { autoSellEnabled: true });
  await audit(identity, 'settings.auto_sell_enabled', { value: true });
  await sendMessage(identity.chatId, 'Auto-sell exits enabled.');
}

async function handleDisableExit(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { autoSellEnabled: false });
  await audit(identity, 'settings.auto_sell_enabled', { value: false });
  await sendMessage(identity.chatId, 'Auto-sell exits disabled.');
}

async function handleSettings(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const settings = await getUserSettings(identity.walletContext.userId);
  await sendMessage(
    identity.chatId,
    [
      '*Settings*',
      `Auto-buy: \`${String(settings.auto_buy_enabled)}\``,
      `Auto-sell exits: \`${String(settings.auto_sell_enabled)}\``,
      `Max buy size: \`${String(settings.max_buy_sol)} SOL\``,
      `Daily limit: \`${String(settings.daily_limit_sol)} SOL\``,
      `Min score: \`${String(settings.min_score)}\``,
      `Stop loss: \`${String(settings.stop_loss_pct)}%\``,
      `Take profit: \`${String(settings.take_profit_pct)}%\``,
      `Slippage: \`${String(settings.slippage_bps)} bps\``,
      `Priority fee: \`${Number(settings.priority_fee_lamports) / 1_000_000_000} SOL\``,
      `Degen Turbo: \`${String(settings.degen_turbo_enabled)}\``,
      `Withdraw max/tx: \`${String(settings.withdraw_max_per_tx_sol)} SOL\``,
      `Withdraw daily: \`${String(settings.withdraw_daily_limit_sol)} SOL\``,
      `Withdraw cooldown: \`${String(settings.withdraw_address_cooldown_minutes)} min\``,
      `Sources: \`${Array.isArray(settings.allowed_sources) ? settings.allowed_sources.join(', ') : '*'}\``
    ].join('\n')
  );
}

async function handleSetSize(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < MIN_BUY_SOL) {
    await sendMessage(identity.chatId, `Usage: \`/setsize 0.05\` (minimum \`${MIN_BUY_SOL} SOL\`).`);
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { maxBuySol: value });
  await audit(identity, 'settings.max_buy_sol', { value });
  await sendMessage(identity.chatId, `Max buy size updated to \`${value} SOL\`.`);
}

async function handleSetDailyLimit(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value <= 0) {
    await sendMessage(identity.chatId, 'Usage: `/setdaily 0.25`');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { dailyLimitSol: value });
  await audit(identity, 'settings.daily_limit_sol', { value });
  await sendMessage(identity.chatId, `Daily limit updated to \`${value} SOL\`.`);
}

async function handleSetMinScore(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    await sendMessage(identity.chatId, 'Usage: `/setminscore 55` with range 0-100.');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { minScore: value });
  await audit(identity, 'settings.min_score', { value });
  await sendMessage(identity.chatId, `Minimum signal score updated to \`${value}\`.`);
}

async function handleDegenMode(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, {
    minScore: DEGEN_MIN_SCORE,
    dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
    slippageBps: DEGEN_SLIPPAGE_BPS,
    priorityFeeLamports: Math.floor(DEGEN_PRIORITY_SOL * 1_000_000_000),
    degenTurboEnabled: true
  });
  await audit(identity, 'settings.degenmode_applied', {
    minScore: DEGEN_MIN_SCORE,
    dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
    slippageBps: DEGEN_SLIPPAGE_BPS,
    prioritySol: DEGEN_PRIORITY_SOL
  });

  await sendMessage(
    identity.chatId,
    [
      '*Degen Fast Preset Applied*',
      `Min score: \`${DEGEN_MIN_SCORE}\``,
      `Daily limit: \`${DEGEN_DAILY_LIMIT_SOL} SOL\``,
      `Slippage: \`${DEGEN_SLIPPAGE_BPS} bps\``,
      `Priority fee: \`${DEGEN_PRIORITY_SOL} SOL\``,
      `Buy floor: \`${MIN_BUY_SOL} SOL\``,
      'Degen Turbo: `true`'
    ].join('\n')
  );
}

async function handleTurboOn(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { degenTurboEnabled: true });
  await audit(identity, 'settings.degen_turbo_enabled', { value: true });
  await sendMessage(identity.chatId, 'Degen Turbo safety guards enabled.');
}

async function handleTurboOff(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { degenTurboEnabled: false });
  await audit(identity, 'settings.degen_turbo_enabled', { value: false });
  await sendMessage(identity.chatId, 'Degen Turbo safety guards disabled.');
}

async function handleTurboStatus(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const settings = await getUserSettings(identity.walletContext.userId);
  await sendMessage(
    identity.chatId,
    [
      '*Degen Turbo Status*',
      `Enabled: \`${String(settings.degen_turbo_enabled)}\``,
      `Max open positions per source: \`${TURBO_MAX_OPEN_POSITIONS_PER_SOURCE}\``,
      `Token cooldown: \`${TURBO_TOKEN_COOLDOWN_MINUTES} minutes\``,
      `Duplicate suppression window: \`${TURBO_DUPLICATE_WINDOW_SECONDS} seconds\``
    ].join('\n')
  );
}

async function handleSetStopLoss(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value <= 0) {
    await sendMessage(identity.chatId, 'Usage: `/setsl 20`');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { stopLossPct: value });
  await audit(identity, 'settings.stop_loss_pct', { value });
  await sendMessage(identity.chatId, `Stop loss updated to \`${value}%\`.`);
}

async function handleSetTakeProfit(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value <= 0) {
    await sendMessage(identity.chatId, 'Usage: `/settp 75`');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { takeProfitPct: value });
  await audit(identity, 'settings.take_profit_pct', { value });
  await sendMessage(identity.chatId, `Take profit updated to \`${value}%\`.`);
}

async function handleSetSlippage(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < 50 || value > 5000) {
    await sendMessage(identity.chatId, 'Usage: `/setslippage 300` with a range between 50 and 5000 bps.');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { slippageBps: value });
  await audit(identity, 'settings.slippage_bps', { value });
  await sendMessage(identity.chatId, `Slippage updated to \`${value} bps\`.`);
}

async function handleSetPriority(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const solValue = Number(args[0]);
  if (!Number.isFinite(solValue) || solValue < 0) {
    await sendMessage(identity.chatId, 'Usage: `/setpriority 0.0001`');
    return;
  }

  const lamports = Math.floor(solValue * 1_000_000_000);
  await updateUserSettings(identity.walletContext.userId, { priorityFeeLamports: lamports });
  await audit(identity, 'settings.priority_fee_lamports', { value: lamports });
  await sendMessage(identity.chatId, `Priority fee updated to \`${solValue} SOL\`.`);
}

async function handleSubscribe(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const sources = args.join(' ').split(',').map((item) => item.trim()).filter(Boolean);
  if (!sources.length) {
    await sendMessage(identity.chatId, 'Usage: `/subscribe pumpfun,dexscreener` or `/subscribe *`');
    return;
  }

  await updateUserSettings(identity.walletContext.userId, { allowedSources: sources });
  await audit(identity, 'settings.allowed_sources', { value: sources });
  await sendMessage(identity.chatId, `Allowed sources updated: \`${sources.join(', ')}\``);
}

async function handleStatus(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const orders = await getRecentOrders(identity.walletContext.userId);
  if (!orders.length) {
    await sendMessage(identity.chatId, 'No recent execution orders.');
    return;
  }

  const lines = ['*Recent Orders*'];
  for (const order of orders) {
    lines.push(
      `\`${String(order.side)}\` \`${String(order.mint)}\` -> \`${String(order.status)}\`${order.txsig ? ` (\`${String(order.txsig)}\`)` : ''}`
    );
  }

  await sendMessage(identity.chatId, lines.join('\n'));
}

async function handlePositions(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const positions = await getOpenPositions(identity.walletContext.userId);
  if (!positions.length) {
    await sendMessage(identity.chatId, 'No open positions right now.');
    return;
  }

  const lines = ['*Open Positions*'];
  for (const position of positions) {
    lines.push(
      [
        `Mint: \`${position.mint}\``,
        `Status: \`${position.status}\``,
        `Token amount: \`${position.token_amount_raw}\``,
        `Entry: \`${Number(position.entry_sol_lamports) / 1_000_000_000} SOL\``,
        `TP/SL: \`${position.take_profit_pct}% / ${position.stop_loss_pct}%\``
      ].join(' | ')
    );
  }

  await sendMessage(identity.chatId, lines.join('\n'));
}

async function handleCopyTrade(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const settings = await getUserSettings(identity.walletContext.userId);
  const sources = Array.isArray(settings.allowed_sources) ? settings.allowed_sources : ['*'];
  const copyEnabled = sources.includes('*') || sources.includes('copytrade');

  await sendMessage(
    identity.chatId,
    [
      '*Copy Trade*',
      `Status: \`${copyEnabled ? 'ready' : 'not_subscribed'}\``,
      'Current build executes copy-style entries when upstream signals come with source `copytrade`.',
      'Enable source with `/subscribe copytrade` (or include it in your source list).',
      'Manual fallback remains: `/trade TOKEN_MINT 0.05 300 75 20`.'
    ].join('\n')
  );
}

async function handleDeposits(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const deposits = await getDepositHistory(identity.walletContext.userId);
  if (!deposits.length) {
    await sendMessage(identity.chatId, 'No deposit events recorded yet.');
    return;
  }

  const lines = ['*Deposits*'];
  for (const item of deposits) {
    lines.push(`\`${Number(item.amount_lamports) / 1_000_000_000} SOL\` at \`${item.detected_at}\``);
  }
  await sendMessage(identity.chatId, lines.join('\n'));
}

async function handleWithdraw(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const [destination, amountRaw] = args;
  const amount = Number(amountRaw);
  if (!destination || !Number.isFinite(amount) || amount <= 0) {
    await sendMessage(identity.chatId, 'Usage: `/withdraw DESTINATION_ADDRESS 0.1`');
    return;
  }

  try {
    new PublicKey(destination);
  } catch {
    await sendMessage(identity.chatId, 'Invalid Solana destination address.');
    return;
  }

  const code = newWithdrawCode();
  pendingWithdrawConfirmByChat.set(identity.chatId, {
    code,
    destination,
    amount,
    expiresAt: Date.now() + 5 * 60 * 1000,
    userId: identity.walletContext.userId,
    walletId: identity.walletContext.wallet.id
  });
  await audit(identity, 'withdrawal_confirmation_created', { destination, amount });
  await sendMessage(
    identity.chatId,
    [
      '*Withdraw Confirmation Required*',
      `Destination: \`${destination}\``,
      `Amount: \`${amount} SOL\``,
      `Code: \`${code}\``,
      'Confirm with `/confirmwithdraw CODE` within 5 minutes.'
    ].join('\n')
  );
}

async function handleWithdrawWizardStart(update: TelegramUpdate) {
  const chatId = update.message?.chat.id;
  if (!chatId) {
    return;
  }

  withdrawWizardStateByChat.set(chatId, { step: 'awaiting_destination' });
  await sendMessage(
    chatId,
    [
      '*Withdraw Wizard*',
      'Step 1/2: send destination Solana address.',
      'You can cancel with `/close` or by reopening `/menu`.'
    ].join('\n')
  );
}

async function handleWithdrawWizardInput(update: TelegramUpdate, text: string) {
  const chatId = update.message?.chat.id;
  if (!chatId) {
    return false;
  }

  const state = withdrawWizardStateByChat.get(chatId);
  if (!state) {
    return false;
  }

  if (state.step === 'awaiting_destination') {
    const destination = text.trim();
    try {
      new PublicKey(destination);
    } catch {
      await sendMessage(chatId, 'Invalid address. Send a valid Solana destination address.');
      return true;
    }

    withdrawWizardStateByChat.set(chatId, { step: 'awaiting_amount', destination });
    await sendMessage(chatId, 'Step 2/2: send amount in SOL, e.g. `0.1`');
    return true;
  }

  if (!isValidPositiveSolAmount(text)) {
    await sendMessage(chatId, 'Invalid amount. Send a positive SOL amount, e.g. `0.1`');
    return true;
  }
  const amount = Number(text.trim());

  const identity = await getIdentity(update);
  if (!identity || !state.destination) {
    withdrawWizardStateByChat.delete(chatId);
    return true;
  }

  const code = newWithdrawCode();
  pendingWithdrawConfirmByChat.set(chatId, {
    code,
    destination: state.destination,
    amount,
    expiresAt: Date.now() + 5 * 60 * 1000,
    userId: identity.walletContext.userId,
    walletId: identity.walletContext.wallet.id
  });
  await audit(identity, 'withdrawal_confirmation_created', { destination: state.destination, amount });
  withdrawWizardStateByChat.delete(chatId);
  await sendMessage(
    chatId,
    [
      '*Withdraw Confirmation Required*',
      `Destination: \`${state.destination}\``,
      `Amount: \`${amount} SOL\``,
      `Code: \`${code}\``,
      'Confirm with `/confirmwithdraw CODE` within 5 minutes.'
    ].join('\n')
  );
  return true;
}

async function handleConfirmWithdraw(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const provided = String(args[0] ?? '');
  const pending = pendingWithdrawConfirmByChat.get(identity.chatId);
  if (!pending) {
    await sendMessage(identity.chatId, 'No pending withdrawal confirmation.');
    return;
  }
  if (Date.now() > pending.expiresAt) {
    pendingWithdrawConfirmByChat.delete(identity.chatId);
    await sendMessage(identity.chatId, 'Confirmation expired. Start again with `/withdraw`.');
    return;
  }
  if (provided !== pending.code) {
    await sendMessage(identity.chatId, 'Invalid confirmation code.');
    return;
  }

  try {
    const request = await createWithdrawalRequest(
      pending.userId,
      pending.walletId,
      pending.destination,
      pending.amount
    );
    pendingWithdrawConfirmByChat.delete(identity.chatId);
    await audit(identity, 'withdrawal_requested', {
      destination: pending.destination,
      amount: pending.amount,
      requestId: request.id
    });
    await sendMessage(
      identity.chatId,
      `Withdrawal queued.\nRequest: \`${request.id}\`\nAmount: \`${request.amountLamports / 1_000_000_000} SOL\``
    );
  } catch (error: any) {
    await sendMessage(identity.chatId, `Withdrawal blocked: ${error.message}`);
  }
}

async function handleWithdrawals(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const withdrawals = await getWithdrawalHistory(identity.walletContext.userId);
  if (!withdrawals.length) {
    await sendMessage(identity.chatId, 'No withdrawal requests yet.');
    return;
  }

  const lines = ['*Withdrawals*'];
  for (const item of withdrawals) {
    lines.push(
      `\`${Number(item.amount_lamports) / 1_000_000_000} SOL\` -> \`${String(item.status)}\`${item.txsig ? ` (\`${String(item.txsig)}\`)` : ''}`
    );
  }
  await sendMessage(identity.chatId, lines.join('\n'));
}

async function handleReport(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const orders = await getRecentOrders(identity.walletContext.userId);
  const deposits = await getDepositHistory(identity.walletContext.userId);
  const withdrawals = await getWithdrawalHistory(identity.walletContext.userId);
  const confirmed = orders.filter((item) => item.status === 'CONFIRMED').length;
  const failed = orders.filter((item) => item.status === 'FAILED').length;

  await sendMessage(
    identity.chatId,
    [
      '*Account Report*',
      `Recent orders: \`${orders.length}\``,
      `Confirmed orders: \`${confirmed}\``,
      `Failed orders: \`${failed}\``,
      `Recorded deposits: \`${deposits.length}\``,
      `Withdrawal requests: \`${withdrawals.length}\``,
      'Execution worker polls every 250ms for queued work.'
    ].join('\n')
  );
}

async function handleTrade(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const [mint, amountRaw, slippageRaw, tpRaw, slRaw, idempotencyRaw] = args;
  const amountSol = amountRaw ? Number(amountRaw) : undefined;
  const slippageBps = slippageRaw ? Number(slippageRaw) : undefined;
  const takeProfitPct = tpRaw ? Number(tpRaw) : undefined;
  const stopLossPct = slRaw ? Number(slRaw) : undefined;

  if (!mint) {
    await sendMessage(identity.chatId, 'Usage: `/trade TOKEN_MINT 0.05 300 75 20`');
    return;
  }

  try {
    new PublicKey(mint);
  } catch {
    await sendMessage(identity.chatId, 'Invalid token mint address.');
    return;
  }

  if (amountSol !== undefined && (!Number.isFinite(amountSol) || amountSol < MIN_BUY_SOL)) {
    await sendMessage(identity.chatId, `Trade amount must be at least \`${MIN_BUY_SOL} SOL\`.`);
    return;
  }

  const result = await enqueueManualTradeForUser({
    userId: identity.walletContext.userId,
    mint,
    amountSol,
    slippageBps,
    takeProfitPct,
    stopLossPct,
    idempotencyKey: idempotencyRaw || `bot:${identity.walletContext.userId}:${mint}:${amountRaw ?? 'default'}:${Math.floor(Date.now() / 30000)}`
  });
  await audit(identity, 'manual_trade_queued', { mint, amountSol: result.amountSol, orderId: result.orderId });

  await sendMessage(
    identity.chatId,
    [
      '*Manual trade queued*',
      `Mint: \`${mint}\``,
      `Amount: \`${result.amountSol} SOL\``,
      `Slippage: \`${result.slippageBps} bps\``,
      `Order: \`${result.orderId}\``
    ].join('\n')
  );
}

async function handleWhyTrade(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const decision = await getLatestDecisionReason(identity.walletContext.userId);
  if (!decision) {
    await sendMessage(
      identity.chatId,
      [
        '*Trade Decision Logic*',
        'No orders found yet.',
        `System default min score is 20, degen preset uses ${DEGEN_MIN_SCORE}, and amount must be >= ${MIN_BUY_SOL} SOL.`,
        'Trade executes only when source, score, auto-buy, and risk checks all pass.'
      ].join('\n')
    );
    return;
  }

  const payloadReason = typeof decision.payload?.reason === 'string' ? decision.payload.reason : 'not provided by signal source';
  await sendMessage(
    identity.chatId,
    [
      '*Latest Trade Decision*',
      `Token mint: \`${decision.mint}\``,
      `Signal side: \`${decision.side}\``,
      `Source: \`${decision.source}\``,
      `Score: \`${decision.score ?? 'n/a'}\``,
      `Signal status: \`${decision.signal_status}\``,
      `Order status: \`${decision.order_status}\``,
      `Signal reason: \`${payloadReason}\``,
      `Minimum amount floor: \`${MIN_BUY_SOL} SOL\``,
      'Risk pass: source allowed + score >= your min score + auto-buy enabled + within daily limit + position cap not exceeded.'
    ].join('\n')
  );
}

async function handleExportKey(update: TelegramUpdate, args: string[]) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  if (args[0]?.toUpperCase() !== 'CONFIRM') {
    await sendMessage(identity.chatId, 'Run `/exportkey CONFIRM` if you want the private key shown in this chat.');
    return;
  }

  const exported = await exportWalletSecret(identity.walletContext.wallet.id);
  await audit(identity, 'wallet_private_key_exported', {});
  await sendMessage(
    identity.chatId,
    [
      '*Private Key Export*',
      'Store this offline immediately.',
      `Private key (base64): \`${exported}\``
    ].join('\n')
  );
}

async function handleHelp(update: TelegramUpdate) {
  const chatId = update.message?.chat.id;
  if (!chatId) {
    return;
  }

  await sendMessage(
    chatId,
    [
      '*Execution Bot Guide*',
      '1) `/start` -> creates wallet and onboarding.',
      '2) Fund wallet with SOL -> check with `/wallet`.',
      '3) Configure risk: `/setsize`, `/setdaily`, `/setminscore`, `/setsl`, `/settp`, `/setslippage`, `/setpriority`.',
      `Fast preset in one step: \`/degenmode\` (${DEGEN_MIN_SCORE} score, ${DEGEN_SLIPPAGE_BPS} bps, ${DEGEN_PRIORITY_SOL} SOL priority, ${DEGEN_DAILY_LIMIT_SOL} SOL daily cap).`,
      'Turbo guards: `/turboon` `/turbooff` `/turbostatus`.',
      '4) Select sources with `/subscribe pumpfun,dexscreener`.',
      '5) Enable automation with `/enable` and optional `/enableexit`.',
      '6) Manual order anytime: `/trade TOKEN_MINT 0.05 300 75 20`.',
      '7) Track positions and execution with `/positions`, `/status`, `/report`, `/whytrade`.',
      '',
      '*Risk Pass Means*',
      `- Amount must be >= \`${MIN_BUY_SOL} SOL\``,
      '- Source must be in your allowlist',
      '- Score must be >= your `/setminscore`',
      '- 24h spent + new trade must be <= `/setdaily`',
      '- Open positions must remain under system cap',
      '- If Turbo is on: source cap + cooldown + duplicate suppression are enforced',
      '',
      '*Core Commands*',
      '`/menu` `/help` `/wallet` `/settings` `/enable` `/disable` `/enableexit` `/disableexit`',
      '`/setsize` `/setdaily` `/setminscore` `/degenmode` `/turboon` `/turbooff` `/turbostatus` `/settp` `/setsl` `/setslippage` `/setpriority` `/subscribe`',
      '`/trade` `/buy` `/positions` `/copytrade` `/status` `/deposits` `/withdraw` `/confirmwithdraw CODE` `/withdrawwizard` `/withdrawals` `/report` `/whytrade` `/exportkey CONFIRM`'
    ].join('\n')
  );
}

async function handleUpdate(update: TelegramUpdate) {
  const rawText = update.message?.text?.trim();
  if (!rawText) {
    return;
  }

  if (!rawText.startsWith('/')) {
    const wizardHandled = await handleWithdrawWizardInput(update, rawText);
    if (wizardHandled) {
      return;
    }
  }

  const { command, args } = getCommandAndArgs(rawText);
  switch (command) {
    case '/start':
      return handleStart(update);
    case '/menu':
      return handleMenu(update);
    case '/close':
      return handleClose(update);
    case '/help':
      return handleHelp(update);
    case '/wallet':
      return handleWallet(update);
    case '/enable':
      return handleEnable(update);
    case '/disable':
      return handleDisable(update);
    case '/enableexit':
      return handleEnableExit(update);
    case '/disableexit':
      return handleDisableExit(update);
    case '/settings':
      return handleSettings(update);
    case '/setsize':
    case '/setstake':
      return handleSetSize(update, args);
    case '/setdaily':
      return handleSetDailyLimit(update, args);
    case '/setminscore':
      return handleSetMinScore(update, args);
    case '/degenmode':
      return handleDegenMode(update);
    case '/turboon':
      return handleTurboOn(update);
    case '/turbooff':
      return handleTurboOff(update);
    case '/turbostatus':
      return handleTurboStatus(update);
    case '/settp':
      return handleSetTakeProfit(update, args);
    case '/setsl':
      return handleSetStopLoss(update, args);
    case '/setslippage':
      return handleSetSlippage(update, args);
    case '/setpriority':
      return handleSetPriority(update, args);
    case '/subscribe':
      return handleSubscribe(update, args);
    case '/trade':
    case '/buy':
      return handleTrade(update, args);
    case '/positions':
      return handlePositions(update);
    case '/copytrade':
      return handleCopyTrade(update);
    case '/status':
      return handleStatus(update);
    case '/deposits':
      return handleDeposits(update);
    case '/withdraw':
      if (!args.length) {
        return handleWithdrawWizardStart(update);
      }
      return handleWithdraw(update, args);
    case '/withdrawwizard':
      return handleWithdrawWizardStart(update);
    case '/confirmwithdraw':
      return handleConfirmWithdraw(update, args);
    case '/withdrawals':
      return handleWithdrawals(update);
    case '/report':
      return handleReport(update);
    case '/whytrade':
      return handleWhyTrade(update);
    case '/exportkey':
      return handleExportKey(update, args);
    default:
      return handleHelp(update);
  }
}

export async function startTelegramBot(signal?: AbortSignal) {
  await setCommands();
  let offset = 0;

  while (!signal?.aborted) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        if (signal?.aborted) {
          break;
        }
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error: any) {
      if (signal?.aborted) {
        break;
      }
      logger.error('telegram_poll_error', { message: error.message });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startTelegramBot().catch((error) => {
    logger.error('telegram_bot_fatal', { message: error.message });
    process.exit(1);
  });
}
