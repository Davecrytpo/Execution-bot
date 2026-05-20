import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import {
  answerCallbackQuery,
  deleteWebhook,
  editMessageText,
  getUpdates,
  sendMessage,
  sendPhoto,
  setWebhook,
  setCommands,
  type InlineKeyboardButton,
  type TelegramUpdate
} from '../lib/telegram.js';
import {
  createWithdrawalRequest,
  getCachedWalletBalance,
  getDepositHistory,
  exportWalletSecret,
  getLatestDecisionReason,
  getOpenPositions,
  getOrCreateWallet,
  getRecentOrders,
  getUserSettings,
  getWithdrawalHistory,
  refreshWalletBalanceCache,
  updateUserSettings
} from '../services/custodyService.js';
import { enqueueManualTradeForUser } from '../services/executionService.js';
import { logger } from '../lib/logger.js';
import { logAuditAction } from '../lib/audit.js';
import { isValidPositiveSolAmount } from './wizardLogic.js';
import {
  deriveAutoBuyExecutionState,
  deriveLaunchWorkerStatus,
  derivePumpfunMonitorStatus,
  deriveSourceRoutingState,
  sourceModeLabel
} from './dashboardState.js';
import { getSniperRuntimeStatus } from '../sniper/runtime.js';

const MIN_BUY_SOL = 0.005;
const DEGEN_MIN_SCORE = 18;
const DEGEN_DAILY_LIMIT_SOL = 0.15;
const DEGEN_SLIPPAGE_BPS = 500;
const DEGEN_PRIORITY_SOL = 0.0002;
const TURBO_MAX_OPEN_POSITIONS_PER_SOURCE = 3;
const TURBO_TOKEN_COOLDOWN_MINUTES = 10;
const TURBO_DUPLICATE_WINDOW_SECONDS = 90;
const LAMPORTS_PER_SOL = 1_000_000_000;
const START_BANNER_PATH = join(process.cwd(), 'assets', 'telegram-logo.png');

type DashboardView =
  | 'home'
  | 'wallet'
  | 'wallet_deposits'
  | 'wallet_withdrawals'
  | 'wallet_withdraw_confirm'
  | 'wallet_export_confirm'
  | 'trading'
  | 'auto_buy'
  | 'auto_sell'
  | 'settings'
  | 'safety'
  | 'analytics'
  | 'analytics_positions'
  | 'analytics_orders'
  | 'analytics_report'
  | 'analytics_decision'
  | 'sources'
  | 'sniper'
  | 'support';

type PendingInput =
  | { kind: 'trade_mint' }
  | { kind: 'trade_amount'; mint: string }
  | { kind: 'set_max_buy' }
  | { kind: 'set_daily_limit' }
  | { kind: 'set_min_score' }
  | { kind: 'set_take_profit' }
  | { kind: 'set_stop_loss' }
  | { kind: 'set_slippage' }
  | { kind: 'set_priority' }
  | { kind: 'withdraw_destination' }
  | { kind: 'withdraw_amount'; destination: string };

type DashboardSession = {
  messageId?: number;
  view: DashboardView;
  pendingInput?: PendingInput;
};

type WithdrawalConfirmation = {
  code: string;
  destination: string;
  amount: number;
  expiresAt: number;
  userId: string;
  walletId: string;
};

type BotIdentity = {
  chatId: number;
  from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  walletContext: Awaited<ReturnType<typeof getOrCreateWallet>>;
};

type DashboardRender = {
  text: string;
  buttons: InlineKeyboardButton[][];
};

const VIEW_PARENT: Partial<Record<DashboardView, DashboardView>> = {
  wallet: 'home',
  wallet_deposits: 'wallet',
  wallet_withdrawals: 'wallet',
  wallet_withdraw_confirm: 'wallet',
  wallet_export_confirm: 'wallet',
  trading: 'home',
  auto_buy: 'home',
  auto_sell: 'home',
  settings: 'home',
  safety: 'home',
  analytics: 'home',
  analytics_positions: 'analytics',
  analytics_orders: 'analytics',
  analytics_report: 'analytics',
  analytics_decision: 'analytics',
  sources: 'trading',
  sniper: 'trading',
  support: 'home'
};

const dashboardSessionByChat = new Map<number, DashboardSession>();
const pendingWithdrawConfirmByChat = new Map<number, WithdrawalConfirmation>();
const startBannerShownByChat = new Set<number>();

function button(text: string, callbackData: string): InlineKeyboardButton {
  return { text, callback_data: callbackData };
}

function getDashboardSession(chatId: number): DashboardSession {
  const existing = dashboardSessionByChat.get(chatId);
  if (existing) {
    return existing;
  }

  const created: DashboardSession = { view: 'home' };
  dashboardSessionByChat.set(chatId, created);
  return created;
}

function newWithdrawCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function solFromLamports(lamports: string | number | null | undefined) {
  const numeric = Number(lamports ?? 0);
  return Number.isFinite(numeric) ? numeric / LAMPORTS_PER_SOL : 0;
}

function formatSol(value: number | string | null | undefined, digits = 4) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '0.0000';
}

function formatCheckedAt(value: string | null | undefined) {
  if (!value) {
    return 'Not synced yet';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function formatStatusTimestamp(value: string | null | undefined, emptyLabel: string) {
  return value ? formatCheckedAt(value) : emptyLabel;
}

function humanizeErrorMessage(error: unknown) {
  const message = String(error instanceof Error ? error.message : error ?? 'unknown_error');
  const knownMessages: Record<string, string> = {
    withdrawal_exceeds_max_per_tx: 'This withdrawal is above your single-transaction limit.',
    withdrawal_exceeds_daily_limit: 'This withdrawal would exceed your daily withdrawal limit.',
    withdraw_destination_cooldown_active: 'You recently changed withdrawal destination. Please wait for the cooldown window to end.',
    user_not_found: 'Your user profile was not found. Please try /start again.',
    user_or_wallet_not_found: 'Your wallet was not found. Please reopen the dashboard with /menu.',
    rpc_send_no_endpoints: 'No healthy RPC endpoint is available right now. Please try again shortly.',
    rpc_all_failed: 'Live Solana RPC is temporarily unavailable. Please try again shortly.'
  };

  if (knownMessages[message]) {
    return knownMessages[message];
  }

  if (message.startsWith('rpc_all_failed:')) {
    return 'Live Solana RPC is temporarily unavailable. Please try again shortly.';
  }

  return message.replace(/[_`*[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pendingPrompt(input?: PendingInput): string | undefined {
  if (!input) {
    return undefined;
  }

  switch (input.kind) {
    case 'trade_mint':
      return 'Send the token mint you want to buy.';
    case 'trade_amount':
      return `Mint saved: \`${input.mint}\`. Send the amount in SOL, for example \`0.05\`.`;
    case 'set_max_buy':
      return `Send your new max buy size in SOL. Minimum is \`${MIN_BUY_SOL} SOL\`.`;
    case 'set_daily_limit':
      return 'Send your new daily buy limit in SOL, for example `0.25`.';
    case 'set_min_score':
      return 'Send your new minimum score from 0 to 100.';
    case 'set_take_profit':
      return 'Send your new take-profit percent, for example `75`.';
    case 'set_stop_loss':
      return 'Send your new stop-loss percent, for example `20`.';
    case 'set_slippage':
      return 'Send your new slippage in basis points, between `50` and `5000`.';
    case 'set_priority':
      return 'Send your new priority fee in SOL, for example `0.0001`.';
    case 'withdraw_destination':
      return 'Send the Solana wallet address you want to withdraw to.';
    case 'withdraw_amount':
      return `Destination saved: \`${input.destination}\`. Send the withdrawal amount in SOL.`;
    default:
      return undefined;
  }
}

function composeDashboardText(title: string, body: string[], notice?: string, prompt?: string) {
  const lines = ['*Execution Bot Dashboard*', `_${title}_`, ''];

  if (notice) {
    lines.push(`*Update:* ${notice}`, '');
  }

  if (prompt) {
    lines.push(`*Action needed:* ${prompt}`, '');
  }

  lines.push(...body);
  return lines.join('\n');
}

async function safeCachedWalletBalance(walletId: string) {
  try {
    return await getCachedWalletBalance(walletId);
  } catch {
    return {
      balanceSol: null,
      checkedAt: null
    };
  }
}

function isCallbackUpdate(update: TelegramUpdate): boolean {
  return Boolean(update.callback_query);
}

function getCallbackMessageId(update: TelegramUpdate) {
  return update.callback_query?.message?.message_id;
}

function getUpdateChatId(update: TelegramUpdate) {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
}

async function getIdentity(update: TelegramUpdate): Promise<BotIdentity | null> {
  const from = update.message?.from ?? update.callback_query?.from;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
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

async function audit(identity: BotIdentity, action: string, metadata?: Record<string, unknown>) {
  await logAuditAction({
    userId: identity.walletContext.userId,
    chatId: identity.chatId,
    action,
    metadata
  });
}

async function sendStartBanner(chatId: number) {
  await sendPhoto(chatId, START_BANNER_PATH, {
    caption: 'Execution Bot\nModern Solana trading dashboard for wallet, trading, safety, and analytics.'
  });
}

async function renderDashboard(
  identity: BotIdentity,
  view: DashboardView,
  options?: {
    notice?: string;
    preservePending?: boolean;
    preferredMessageId?: number;
  }
) {
  const session = getDashboardSession(identity.chatId);
  session.view = view;
  if (!options?.preservePending) {
    session.pendingInput = undefined;
  }

  const payload = await buildDashboardView(identity, session, options?.notice);
  const preferredMessageId = options?.preferredMessageId ?? session.messageId;

  if (preferredMessageId) {
    try {
      await editMessageText(identity.chatId, preferredMessageId, payload.text, {
        replyMarkup: { inline_keyboard: payload.buttons }
      });
      session.messageId = preferredMessageId;
      return;
    } catch (error: any) {
      if (String(error.message).includes('message is not modified')) {
        session.messageId = preferredMessageId;
        return;
      }

      logger.error('telegram_dashboard_edit_failed', { message: error.message, view });
    }
  }

  const message = await sendMessage(identity.chatId, payload.text, {
    replyMarkup: { inline_keyboard: payload.buttons }
  });
  session.messageId = message.message_id;
}

async function closeDashboard(identity: BotIdentity) {
  const session = getDashboardSession(identity.chatId);
  session.pendingInput = undefined;

  const text = [
    '*Dashboard hidden*',
    'Use `/menu` any time to reopen your trading dashboard.'
  ].join('\n');

  if (session.messageId) {
    try {
      await editMessageText(identity.chatId, session.messageId, text, {
        replyMarkup: {
          inline_keyboard: [[button('Open Dashboard', 'view:home')]]
        }
      });
      return;
    } catch (error: any) {
      logger.error('telegram_dashboard_close_failed', { message: error.message });
    }
  }

  const message = await sendMessage(identity.chatId, text, {
    replyMarkup: {
      inline_keyboard: [[button('Open Dashboard', 'view:home')]]
    }
  });
  session.messageId = message.message_id;
}

function navRows(view: DashboardView): InlineKeyboardButton[][] {
  const parent = VIEW_PARENT[view];
  const rows: InlineKeyboardButton[][] = [];

  if (parent) {
    rows.push([button('◀️ Back', `view:${parent}`), button('🏠 Home', 'view:home')]);
  } else if (view !== 'home') {
    rows.push([button('🏠 Home', 'view:home')]);
  } else {
    rows.push([button('🔄 Refresh', 'view:home')]);
  }

  return rows;
}

async function buildDashboardView(identity: BotIdentity, session: DashboardSession, notice?: string): Promise<DashboardRender> {
  const prompt = pendingPrompt(session.pendingInput);
  switch (session.view) {
    case 'wallet':
      return renderWalletView(identity, notice, prompt);
    case 'wallet_deposits':
      return renderWalletDepositsView(identity, notice, prompt);
    case 'wallet_withdrawals':
      return renderWalletWithdrawalsView(identity, notice, prompt);
    case 'wallet_withdraw_confirm':
      return renderWalletWithdrawConfirmView(identity, notice, prompt);
    case 'wallet_export_confirm':
      return renderWalletExportConfirmView(notice, prompt);
    case 'trading':
      return renderTradingView(identity, notice, prompt);
    case 'auto_buy':
      return renderAutoBuyView(identity, notice, prompt);
    case 'auto_sell':
      return renderAutoSellView(identity, notice, prompt);
    case 'settings':
      return renderSettingsView(identity, notice, prompt);
    case 'safety':
      return renderSafetyView(identity, notice, prompt);
    case 'analytics':
      return renderAnalyticsView(identity, notice, prompt);
    case 'analytics_positions':
      return renderPositionsView(identity, notice, prompt);
    case 'analytics_orders':
      return renderOrdersView(identity, notice, prompt);
    case 'analytics_report':
      return renderReportView(identity, notice, prompt);
    case 'analytics_decision':
      return renderDecisionView(identity, notice, prompt);
    case 'sources':
      return renderSourcesView(identity, notice, prompt);
    case 'sniper':
      return renderSniperView(identity, notice, prompt);
    case 'support':
      return renderSupportView(notice, prompt);
    case 'home':
    default:
      return renderHomeView(identity, notice, prompt);
  }
}

async function renderHomeView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const balance = await safeCachedWalletBalance(identity.walletContext.wallet.id);
  const routing = deriveSourceRoutingState(settings.allowed_sources);
  const autoBuyState = deriveAutoBuyExecutionState({
    autoBuyEnabled: settings.auto_buy_enabled,
    routing,
    launchWorkerConfigured: config.enableSniperWorker,
    workerState: getSniperRuntimeStatus().state
  });

  const body = [
    '*Overview*',
    `Wallet balance: \`${balance.balanceSol === null ? 'Tap Wallet to sync' : `${formatSol(balance.balanceSol)} SOL`}\``,
    `Balance sync: \`${formatCheckedAt(balance.checkedAt)}\``,
    `Auto Buy: \`${autoBuyState.label}\``,
    `Auto Sell: \`${settings.auto_sell_enabled ? 'ON' : 'OFF'}\``,
    `Signal mode: \`${sourceModeLabel(settings.allowed_sources)}\``,
    `Risk mode: \`${settings.degen_turbo_enabled ? 'Turbo Guarded' : 'Standard'}\``,
    '',
    'Choose a section below to manage your bot like a clean trading dashboard.'
  ];

  return {
    text: composeDashboardText('Home', body, notice, prompt),
    buttons: [
      [button('👛 Wallet', 'view:wallet'), button('📈 Trading', 'view:trading')],
      [button('🤖 Auto Buy', 'view:auto_buy'), button('🎯 Auto Sell', 'view:auto_sell')],
      [button('⚙️ Settings', 'view:settings'), button('🛡️ Safety', 'view:safety')],
      [button('📊 Analytics', 'view:analytics'), button('🆘 Support', 'view:support')],
      ...navRows('home')
    ]
  };
}

async function renderWalletView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const balance = await safeCachedWalletBalance(identity.walletContext.wallet.id);

  const body = [
    '*Wallet*',
    `Address: \`${identity.walletContext.wallet.public_key}\``,
    `Balance: \`${balance.balanceSol === null ? 'Tap Sync Live Balance' : `${formatSol(balance.balanceSol)} SOL`}\``,
    `Last sync: \`${formatCheckedAt(balance.checkedAt)}\``,
    `Withdraw max per tx: \`${formatSol(settings.withdraw_max_per_tx_sol, 3)} SOL\``,
    `Withdraw daily limit: \`${formatSol(settings.withdraw_daily_limit_sol, 3)} SOL\``,
    `Destination cooldown: \`${settings.withdraw_address_cooldown_minutes} minutes\``,
    '',
    'Use the actions below for live balance sync, deposits, withdrawals, and secure key export.'
  ];

  return {
    text: composeDashboardText('Wallet', body, notice, prompt),
    buttons: [
      [button('🔄 Refresh Balance', 'act:wallet_refresh'), button('📥 Deposits', 'view:wallet_deposits')],
      [button('💸 Withdraw', 'prompt:withdraw'), button('📜 Withdrawal History', 'view:wallet_withdrawals')],
      [button('🔐 Private Key Export', 'view:wallet_export_confirm')],
      ...navRows('wallet')
    ]
  };
}

async function renderWalletDepositsView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const deposits = await getDepositHistory(identity.walletContext.userId);
  const lines = deposits.length
    ? deposits.map((item) => `- \`${formatSol(solFromLamports(item.amount_lamports), 4)} SOL\` at \`${item.detected_at}\``)
    : ['No deposits recorded yet.'];

  return {
    text: composeDashboardText('Deposit History', ['*Recent deposits*', ...lines], notice, prompt),
    buttons: [
      [button('🔄 Refresh', 'view:wallet_deposits')],
      ...navRows('wallet_deposits')
    ]
  };
}

async function renderWalletWithdrawalsView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const withdrawals = await getWithdrawalHistory(identity.walletContext.userId);
  const lines = withdrawals.length
    ? withdrawals.map((item) => {
      const amount = formatSol(solFromLamports(item.amount_lamports), 4);
      const tx = item.txsig ? ` | sig: \`${String(item.txsig)}\`` : '';
      return `- \`${amount} SOL\` -> \`${String(item.status)}\`${tx}`;
    })
    : ['No withdrawal requests yet.'];

  return {
    text: composeDashboardText('Withdrawal History', ['*Recent withdrawals*', ...lines], notice, prompt),
    buttons: [
      [button('➕ New Withdrawal', 'prompt:withdraw')],
      ...navRows('wallet_withdrawals')
    ]
  };
}

function renderWalletWithdrawConfirmView(identity: BotIdentity, notice?: string, prompt?: string): DashboardRender {
  const pending = pendingWithdrawConfirmByChat.get(identity.chatId);
  const body = pending
    ? [
      '*Confirm withdrawal*',
      `Destination: \`${pending.destination}\``,
      `Amount: \`${formatSol(pending.amount, 4)} SOL\``,
      `Reference code: \`${pending.code}\``,
      'Review carefully before submitting.'
    ]
    : [
      '*Confirm withdrawal*',
      'No pending withdrawal is waiting for confirmation.'
    ];

  return {
    text: composeDashboardText('Withdrawal Confirmation', body, notice, prompt),
    buttons: pending
      ? [
        [button('✅ Confirm Withdrawal', 'act:withdraw_confirm')],
        [button('✖️ Cancel', 'act:withdraw_cancel')],
        ...navRows('wallet_withdraw_confirm')
      ]
      : navRows('wallet_withdraw_confirm')
  };
}

function renderWalletExportConfirmView(notice?: string, prompt?: string): DashboardRender {
  const body = [
    '*Private key export*',
    'This reveals your wallet secret in chat.',
    'Only continue if you are moving the key to secure offline storage.'
  ];

  return {
    text: composeDashboardText('Private Key Export', body, notice, prompt),
    buttons: [
      [button('🚨 Reveal Private Key', 'act:export_confirm')],
      ...navRows('wallet_export_confirm')
    ]
  };
}

async function renderTradingView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const body = [
    '*Trading Controls*',
    `Default buy size: \`${formatSol(settings.max_buy_sol, 4)} SOL\``,
    `Default slippage: \`${settings.slippage_bps} bps\``,
    `Source mode: \`${sourceModeLabel(settings.allowed_sources)}\``,
    '',
    'Start a guided manual trade or review active trading sources.'
  ];

  return {
    text: composeDashboardText('Trading', body, notice, prompt),
    buttons: [
      [button('🛒 New Trade', 'prompt:trade'), button('📦 Positions', 'view:analytics_positions')],
      [button('🧾 Recent Orders', 'view:analytics_orders'), button('📡 Sources', 'view:sources')],
      [button('🎯 Sniper Status', 'view:sniper')],
      ...navRows('trading')
    ]
  };
}

async function renderAutoBuyView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const routing = deriveSourceRoutingState(settings.allowed_sources);
  const autoBuyState = deriveAutoBuyExecutionState({
    autoBuyEnabled: settings.auto_buy_enabled,
    routing,
    launchWorkerConfigured: config.enableSniperWorker,
    workerState: getSniperRuntimeStatus().state
  });
  const body = [
    '*Auto Buy*',
    `Execution status: \`${autoBuyState.label}\``,
    `Switch: \`${settings.auto_buy_enabled ? 'ON' : 'OFF'}\``,
    `Max buy size: \`${formatSol(settings.max_buy_sol, 4)} SOL\``,
    `Daily limit: \`${formatSol(settings.daily_limit_sol, 4)} SOL\``,
    `Minimum score: \`${settings.min_score}\``,
    `Signal mode: \`${sourceModeLabel(settings.allowed_sources)}\``,
    '',
    autoBuyState.detail
  ];

  return {
    text: composeDashboardText('Auto Buy', body, notice, prompt),
    buttons: [
      [button(settings.auto_buy_enabled ? '🛑 Turn Auto Buy OFF' : '✅ Turn Auto Buy ON', 'act:toggle_auto_buy')],
      [button('💰 Set Buy Size', 'prompt:set_max_buy'), button('📅 Set Daily Limit', 'prompt:set_daily_limit')],
      [button('⭐ Set Min Score', 'prompt:set_min_score'), button('📡 Sources', 'view:sources')],
      [button('🔥 Apply Degen Preset', 'act:degen_preset')],
      ...navRows('auto_buy')
    ]
  };
}

async function renderAutoSellView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const body = [
    '*Auto Sell*',
    `Status: \`${settings.auto_sell_enabled ? 'ON' : 'OFF'}\``,
    `Take profit: \`${settings.take_profit_pct}%\``,
    `Stop loss: \`${settings.stop_loss_pct}%\``,
    '',
    'Use toggles and simple controls instead of separate technical commands.'
  ];

  return {
    text: composeDashboardText('Auto Sell', body, notice, prompt),
    buttons: [
      [button(settings.auto_sell_enabled ? '🛑 Turn Auto Sell OFF' : '✅ Turn Auto Sell ON', 'act:toggle_auto_sell')],
      [button('🏁 Set Take Profit', 'prompt:set_take_profit'), button('🧯 Set Stop Loss', 'prompt:set_stop_loss')],
      ...navRows('auto_sell')
    ]
  };
}

async function renderSettingsView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const body = [
    '*Settings*',
    `Slippage: \`${settings.slippage_bps} bps\``,
    `Priority fee: \`${formatSol(solFromLamports(settings.priority_fee_lamports), 6)} SOL\``,
    '',
    'Advanced execution controls are grouped here to keep the main experience clean.'
  ];

  return {
    text: composeDashboardText('Settings', body, notice, prompt),
    buttons: [
      [button('🌊 Set Slippage', 'prompt:set_slippage'), button('⚡ Set Priority Fee', 'prompt:set_priority')],
      ...navRows('settings')
    ]
  };
}

async function renderSafetyView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const body = [
    '*Safety*',
    `Turbo guard: \`${settings.degen_turbo_enabled ? 'ON' : 'OFF'}\``,
    `Max open positions per source: \`${TURBO_MAX_OPEN_POSITIONS_PER_SOURCE}\``,
    `Token cooldown: \`${TURBO_TOKEN_COOLDOWN_MINUTES} minutes\``,
    `Duplicate suppression: \`${TURBO_DUPLICATE_WINDOW_SECONDS} seconds\``,
    `Withdraw max per tx: \`${formatSol(settings.withdraw_max_per_tx_sol, 3)} SOL\``,
    `Withdraw daily limit: \`${formatSol(settings.withdraw_daily_limit_sol, 3)} SOL\``
  ];

  return {
    text: composeDashboardText('Safety', body, notice, prompt),
    buttons: [
      [button(settings.degen_turbo_enabled ? '🛑 Turn Turbo Guard OFF' : '✅ Turn Turbo Guard ON', 'act:toggle_turbo')],
      [button('💸 Withdraw', 'prompt:withdraw'), button('🔐 Private Key Export', 'view:wallet_export_confirm')],
      ...navRows('safety')
    ]
  };
}

async function renderAnalyticsView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const orders = await getRecentOrders(identity.walletContext.userId);
  const positions = await getOpenPositions(identity.walletContext.userId);
  const withdrawals = await getWithdrawalHistory(identity.walletContext.userId);

  const body = [
    '*Analytics*',
    `Open positions: \`${positions.length}\``,
    `Recent orders: \`${orders.length}\``,
    `Recent withdrawals: \`${withdrawals.length}\``,
    '',
    'Review your activity and the latest trade reasoning here.'
  ];

  return {
    text: composeDashboardText('Analytics', body, notice, prompt),
    buttons: [
      [button('📦 Positions', 'view:analytics_positions'), button('🧾 Recent Orders', 'view:analytics_orders')],
      [button('📈 Account Report', 'view:analytics_report'), button('🧠 Why Last Trade', 'view:analytics_decision')],
      ...navRows('analytics')
    ]
  };
}

async function renderPositionsView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const positions = await getOpenPositions(identity.walletContext.userId);
  const lines = positions.length
    ? positions.map((position) =>
      `- \`${position.mint}\` | \`${position.status}\` | entry \`${formatSol(solFromLamports(position.entry_sol_lamports), 4)} SOL\` | TP/SL \`${position.take_profit_pct}% / ${position.stop_loss_pct}%\``
    )
    : ['No open positions right now.'];

  return {
    text: composeDashboardText('Open Positions', ['*Position summary*', ...lines], notice, prompt),
    buttons: [
      [button('🔄 Refresh', 'view:analytics_positions')],
      ...navRows('analytics_positions')
    ]
  };
}

async function renderOrdersView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const orders = await getRecentOrders(identity.walletContext.userId);
  const lines = orders.length
    ? orders.map((order) =>
      `- \`${String(order.side)}\` \`${String(order.mint)}\` -> \`${String(order.status)}\`${order.txsig ? ` | sig: \`${String(order.txsig)}\`` : ''}`
    )
    : ['No recent execution orders.'];

  return {
    text: composeDashboardText('Recent Orders', ['*Execution history*', ...lines], notice, prompt),
    buttons: [
      [button('🔄 Refresh', 'view:analytics_orders')],
      ...navRows('analytics_orders')
    ]
  };
}

async function renderReportView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const orders = await getRecentOrders(identity.walletContext.userId);
  const deposits = await getDepositHistory(identity.walletContext.userId);
  const withdrawals = await getWithdrawalHistory(identity.walletContext.userId);
  const confirmed = orders.filter((item) => item.status === 'CONFIRMED').length;
  const failed = orders.filter((item) => item.status === 'FAILED').length;

  const body = [
    '*Account report*',
    `Recent orders: \`${orders.length}\``,
    `Confirmed orders: \`${confirmed}\``,
    `Failed orders: \`${failed}\``,
    `Recorded deposits: \`${deposits.length}\``,
    `Withdrawal requests: \`${withdrawals.length}\``
  ];

  return {
    text: composeDashboardText('Account Report', body, notice, prompt),
    buttons: navRows('analytics_report')
  };
}

async function renderDecisionView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const decision = await getLatestDecisionReason(identity.walletContext.userId);
  const body = decision
    ? [
      '*Latest trade decision*',
      `Token mint: \`${decision.mint}\``,
      `Source: \`${decision.source}\``,
      `Score: \`${decision.score ?? 'n/a'}\``,
      `Signal status: \`${decision.signal_status}\``,
      `Order status: \`${decision.order_status}\``,
      `Reason: \`${typeof decision.payload?.reason === 'string' ? decision.payload.reason : 'not provided'}\``
    ]
    : [
      '*Latest trade decision*',
      'No decision history yet.',
      `System buy floor: \`${MIN_BUY_SOL} SOL\``,
      'A trade is allowed only when source, score, auto-buy, and risk checks all pass.'
    ];

  return {
    text: composeDashboardText('Trade Reasoning', body, notice, prompt),
    buttons: navRows('analytics_decision')
  };
}

async function renderSourcesView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const routing = deriveSourceRoutingState(settings.allowed_sources);
  const runtime = getSniperRuntimeStatus();
  const autoBuyState = deriveAutoBuyExecutionState({
    autoBuyEnabled: settings.auto_buy_enabled,
    routing,
    launchWorkerConfigured: config.enableSniperWorker,
    workerState: runtime.state
  });
  const body = [
    '*Signal Sources*',
    `Current mode: \`${sourceModeLabel(settings.allowed_sources)}\``,
    `Pump.fun route: \`${routing.pumpfunEnabled ? 'ON' : 'OFF'}\``,
    `DexScreener route: \`${routing.dexscreenerEnabled ? 'ON' : 'OFF'}\``,
    `Copy Trade route: \`${routing.copytradeEnabled ? 'ON' : 'OFF'}\``,
    `Launch worker: \`${deriveLaunchWorkerStatus(config.enableSniperWorker, runtime.state)}\``,
    `Auto Buy pipeline: \`${autoBuyState.label}\``,
    '',
    autoBuyState.detail
  ];

  return {
    text: composeDashboardText('Source Routing', body, notice, prompt),
    buttons: [
      [button('🎯 Launch Sniper', 'act:source_sniper'), button('🪞 Copy Trade Only', 'act:source_copy')],
      [button('🔀 Hybrid', 'act:source_hybrid'), button('🌐 All Sources', 'act:source_all')],
      ...navRows('sources')
    ]
  };
}

async function renderSniperView(identity: BotIdentity, notice?: string, prompt?: string): Promise<DashboardRender> {
  const settings = await getUserSettings(identity.walletContext.userId);
  const routing = deriveSourceRoutingState(settings.allowed_sources);
  const runtime = getSniperRuntimeStatus();
  const workerStatus = deriveLaunchWorkerStatus(config.enableSniperWorker, runtime.state);
  const pumpfunStatus = derivePumpfunMonitorStatus(routing, config.enableSniperWorker, runtime.state);
  const autoBuyState = deriveAutoBuyExecutionState({
    autoBuyEnabled: settings.auto_buy_enabled,
    routing,
    launchWorkerConfigured: config.enableSniperWorker,
    workerState: runtime.state
  });

  const body = [
    '*Sniper Status*',
    `Launch worker: \`${workerStatus}\``,
    `Auto Buy pipeline: \`${autoBuyState.label}\``,
    `Auto Buy switch: \`${settings.auto_buy_enabled ? 'ON' : 'OFF'}\``,
    `Routing mode: \`${sourceModeLabel(settings.allowed_sources)}\``,
    `Pump.fun monitor: \`${pumpfunStatus}\``,
    `DexScreener intake: \`${routing.dexscreenerEnabled ? 'ON' : 'OFF'}\``,
    `Copy Trade intake: \`${routing.copytradeEnabled ? 'ON' : 'OFF'}\``,
    `Min score: \`${settings.min_score}\``,
    `Max buy size: \`${formatSol(settings.max_buy_sol, 4)} SOL\``,
    `Last launch seen: \`${formatStatusTimestamp(runtime.lastLaunchDetectedAt, 'No launch observed yet')}\``,
    `Last sniper queue: \`${formatStatusTimestamp(runtime.lastQueuedSignalAt, 'No sniper buy queued yet')}\``,
    '',
    autoBuyState.detail
  ];

  return {
    text: composeDashboardText('Launch Sniper', body, notice, prompt),
    buttons: [
      [button('📡 Open Sources', 'view:sources'), button('🤖 Open Auto Buy', 'view:auto_buy')],
      ...navRows('sniper')
    ]
  };
}

function renderSupportView(notice?: string, prompt?: string): DashboardRender {
  const body = [
    '*Support & Guide*',
    'Visible commands are intentionally minimal now:',
    '`/start` `/menu` `/wallet` `/trade` `/status` `/help` `/close`',
    '',
    'Use the dashboard buttons for almost everything else.',
    'Manual power-user commands still work if you type them directly.'
  ];

  return {
    text: composeDashboardText('Support', body, notice, prompt),
    buttons: [
      [button('👛 Open Wallet', 'view:wallet'), button('📈 Open Trading', 'view:trading')],
      [button('⚙️ Open Settings', 'view:settings'), button('📊 Open Analytics', 'view:analytics')],
      ...navRows('support')
    ]
  };
}

async function showDashboard(
  identity: BotIdentity,
  view: DashboardView,
  notice?: string,
  preferredMessageId?: number,
  preservePending = false
) {
  await renderDashboard(identity, view, { notice, preferredMessageId, preservePending });
}

async function showStartExperience(update: TelegramUpdate) {
  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  if (!startBannerShownByChat.has(identity.chatId)) {
    try {
      await sendStartBanner(identity.chatId);
      startBannerShownByChat.add(identity.chatId);
    } catch (error: any) {
      logger.error('telegram_start_banner_failed', { message: error.message });
    }
  }

  const notice = identity.walletContext.exportedKey
    ? 'Your wallet is ready. Save the private key sent below before trading.'
    : 'Your dashboard is live. Use the buttons below instead of typing long command lists.';
  await showDashboard(identity, 'home', notice);

  if (identity.walletContext.exportedKey) {
    await sendMessage(
      identity.chatId,
      [
        '*Wallet created*',
        'Store this private key offline immediately.',
        `Private key (base64): \`${identity.walletContext.exportedKey}\``
      ].join('\n')
    );
  }
}

function parseSourcesArg(args: string[]) {
  return args
    .join(' ')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function updateSourceMode(identity: BotIdentity, allowedSources: string[], notice: string, preferredMessageId?: number) {
  await updateUserSettings(identity.walletContext.userId, { allowedSources });
  await audit(identity, 'settings.allowed_sources', { value: allowedSources });
  await showDashboard(identity, 'sources', notice, preferredMessageId);
}

async function confirmPendingWithdrawal(identity: BotIdentity, providedCode?: string, preferredMessageId?: number) {
  const pending = pendingWithdrawConfirmByChat.get(identity.chatId);
  if (!pending) {
    await showDashboard(identity, 'wallet', 'No pending withdrawal confirmation found.', preferredMessageId);
    return;
  }

  if (Date.now() > pending.expiresAt) {
    pendingWithdrawConfirmByChat.delete(identity.chatId);
    await showDashboard(identity, 'wallet', 'The pending withdrawal expired. Start again from Wallet.', preferredMessageId);
    return;
  }

  if (providedCode && providedCode !== pending.code) {
    await showDashboard(identity, 'wallet_withdraw_confirm', 'The confirmation code did not match.', preferredMessageId);
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
    await showDashboard(
      identity,
      'wallet',
      `Withdrawal queued for ${formatSol(pending.amount, 4)} SOL. Request: ${request.id}`,
      preferredMessageId
    );
  } catch (error: any) {
    await showDashboard(
      identity,
      'wallet_withdraw_confirm',
      `Withdrawal blocked: ${humanizeErrorMessage(error)}`,
      preferredMessageId
    );
  }
}

async function processPendingInput(update: TelegramUpdate, text: string) {
  const identity = await getIdentity(update);
  if (!identity) {
    return false;
  }

  const session = getDashboardSession(identity.chatId);
  const pending = session.pendingInput;
  if (!pending) {
    return false;
  }
  const activeDashboardMessageId = session.messageId;

  try {
    switch (pending.kind) {
      case 'trade_mint': {
        new PublicKey(text.trim());
        session.pendingInput = { kind: 'trade_amount', mint: text.trim() };
        await showDashboard(identity, 'trading', 'Mint saved. Send the amount in SOL next.', activeDashboardMessageId, true);
        return true;
      }
      case 'trade_amount': {
        const amountSol = Number(text.trim());
        if (!Number.isFinite(amountSol) || amountSol < MIN_BUY_SOL) {
          await showDashboard(identity, 'trading', `Trade amount must be at least ${MIN_BUY_SOL} SOL.`, activeDashboardMessageId, true);
          return true;
        }

        const result = await enqueueManualTradeForUser({
          userId: identity.walletContext.userId,
          mint: pending.mint,
          amountSol
        });
        await audit(identity, 'manual_trade_queued', {
          mint: pending.mint,
          amountSol: result.amountSol,
          orderId: result.orderId
        });
        session.pendingInput = undefined;
        await showDashboard(identity, 'trading', `Trade queued: ${result.amountSol} SOL on ${pending.mint}.`, activeDashboardMessageId);
        return true;
      }
      case 'set_max_buy': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value < MIN_BUY_SOL) {
          await showDashboard(identity, 'auto_buy', `Enter a number not lower than ${MIN_BUY_SOL} SOL.`, activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { maxBuySol: value });
        await audit(identity, 'settings.max_buy_sol', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'auto_buy', `Max buy size updated to ${value} SOL.`, activeDashboardMessageId);
        return true;
      }
      case 'set_daily_limit': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value <= 0) {
          await showDashboard(identity, 'auto_buy', 'Enter a valid daily limit in SOL.', activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { dailyLimitSol: value });
        await audit(identity, 'settings.daily_limit_sol', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'auto_buy', `Daily limit updated to ${value} SOL.`, activeDashboardMessageId);
        return true;
      }
      case 'set_min_score': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          await showDashboard(identity, 'auto_buy', 'Minimum score must be between 0 and 100.', activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { minScore: value });
        await audit(identity, 'settings.min_score', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'auto_buy', `Minimum score updated to ${value}.`, activeDashboardMessageId);
        return true;
      }
      case 'set_take_profit': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value <= 0) {
          await showDashboard(identity, 'auto_sell', 'Take profit must be a positive percent.', activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { takeProfitPct: value });
        await audit(identity, 'settings.take_profit_pct', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'auto_sell', `Take profit updated to ${value}%.`, activeDashboardMessageId);
        return true;
      }
      case 'set_stop_loss': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value <= 0) {
          await showDashboard(identity, 'auto_sell', 'Stop loss must be a positive percent.', activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { stopLossPct: value });
        await audit(identity, 'settings.stop_loss_pct', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'auto_sell', `Stop loss updated to ${value}%.`, activeDashboardMessageId);
        return true;
      }
      case 'set_slippage': {
        const value = Number(text.trim());
        if (!Number.isFinite(value) || value < 50 || value > 5000) {
          await showDashboard(identity, 'settings', 'Slippage must be between 50 and 5000 bps.', activeDashboardMessageId, true);
          return true;
        }
        await updateUserSettings(identity.walletContext.userId, { slippageBps: value });
        await audit(identity, 'settings.slippage_bps', { value });
        session.pendingInput = undefined;
        await showDashboard(identity, 'settings', `Slippage updated to ${value} bps.`, activeDashboardMessageId);
        return true;
      }
      case 'set_priority': {
        const solValue = Number(text.trim());
        if (!Number.isFinite(solValue) || solValue < 0) {
          await showDashboard(identity, 'settings', 'Priority fee must be zero or higher.', activeDashboardMessageId, true);
          return true;
        }
        const lamports = Math.floor(solValue * LAMPORTS_PER_SOL);
        await updateUserSettings(identity.walletContext.userId, { priorityFeeLamports: lamports });
        await audit(identity, 'settings.priority_fee_lamports', { value: lamports });
        session.pendingInput = undefined;
        await showDashboard(identity, 'settings', `Priority fee updated to ${solValue} SOL.`, activeDashboardMessageId);
        return true;
      }
      case 'withdraw_destination': {
        new PublicKey(text.trim());
        session.pendingInput = { kind: 'withdraw_amount', destination: text.trim() };
        await showDashboard(identity, 'wallet', 'Destination saved. Send the withdrawal amount in SOL.', activeDashboardMessageId, true);
        return true;
      }
      case 'withdraw_amount': {
        if (!isValidPositiveSolAmount(text)) {
          await showDashboard(identity, 'wallet', 'Withdrawal amount must be a positive SOL amount.', activeDashboardMessageId, true);
          return true;
        }

        const amount = Number(text.trim());
        const code = newWithdrawCode();
        pendingWithdrawConfirmByChat.set(identity.chatId, {
          code,
          destination: pending.destination,
          amount,
          expiresAt: Date.now() + 5 * 60 * 1000,
          userId: identity.walletContext.userId,
          walletId: identity.walletContext.wallet.id
        });
        await audit(identity, 'withdrawal_confirmation_created', { destination: pending.destination, amount });
        session.pendingInput = undefined;
        await showDashboard(identity, 'wallet_withdraw_confirm', 'Review the withdrawal and confirm it below.', activeDashboardMessageId);
        return true;
      }
      default:
        return false;
    }
  } catch (error: any) {
    if (pending.kind === 'trade_mint' || pending.kind === 'withdraw_destination') {
      const targetView = pending.kind === 'trade_mint' ? 'trading' : 'wallet';
      await showDashboard(identity, targetView, 'That address or mint was not valid.', activeDashboardMessageId, true);
      return true;
    }

    await showDashboard(identity, session.view, humanizeErrorMessage(error), activeDashboardMessageId, true);
    return true;
  }
}

async function handleCallbackQuery(update: TelegramUpdate) {
  const callback = update.callback_query;
  if (!callback?.data) {
    return;
  }

  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const session = getDashboardSession(identity.chatId);
  const preferredMessageId = getCallbackMessageId(update);
  if (preferredMessageId) {
    session.messageId = preferredMessageId;
  }

  await answerCallbackQuery(callback.id).catch(() => undefined);

  switch (callback.data) {
      case 'view:home':
        await showDashboard(identity, 'home', undefined, preferredMessageId);
        return;
      case 'view:wallet':
        await showDashboard(identity, 'wallet', undefined, preferredMessageId);
        return;
      case 'view:wallet_deposits':
        await showDashboard(identity, 'wallet_deposits', undefined, preferredMessageId);
        return;
      case 'view:wallet_withdrawals':
        await showDashboard(identity, 'wallet_withdrawals', undefined, preferredMessageId);
        return;
      case 'view:wallet_export_confirm':
        await showDashboard(identity, 'wallet_export_confirm', undefined, preferredMessageId);
        return;
      case 'view:trading':
        await showDashboard(identity, 'trading', undefined, preferredMessageId);
        return;
      case 'view:auto_buy':
        await showDashboard(identity, 'auto_buy', undefined, preferredMessageId);
        return;
      case 'view:auto_sell':
        await showDashboard(identity, 'auto_sell', undefined, preferredMessageId);
        return;
      case 'view:settings':
        await showDashboard(identity, 'settings', undefined, preferredMessageId);
        return;
      case 'view:safety':
        await showDashboard(identity, 'safety', undefined, preferredMessageId);
        return;
      case 'view:analytics':
        await showDashboard(identity, 'analytics', undefined, preferredMessageId);
        return;
      case 'view:analytics_positions':
        await showDashboard(identity, 'analytics_positions', undefined, preferredMessageId);
        return;
      case 'view:analytics_orders':
        await showDashboard(identity, 'analytics_orders', undefined, preferredMessageId);
        return;
      case 'view:analytics_report':
        await showDashboard(identity, 'analytics_report', undefined, preferredMessageId);
        return;
      case 'view:analytics_decision':
        await showDashboard(identity, 'analytics_decision', undefined, preferredMessageId);
        return;
      case 'view:sources':
        await showDashboard(identity, 'sources', undefined, preferredMessageId);
        return;
      case 'view:sniper':
        await showDashboard(identity, 'sniper', undefined, preferredMessageId);
        return;
      case 'view:support':
        await showDashboard(identity, 'support', undefined, preferredMessageId);
        return;
      case 'act:wallet_refresh': {
        const balance = await refreshWalletBalanceCache(
          identity.walletContext.wallet.id,
          identity.walletContext.wallet.public_key
        );
        await showDashboard(
          identity,
          'wallet',
          `Live balance synced successfully: ${formatSol(balance.balanceSol)} SOL.`,
          preferredMessageId
        );
        return;
      }
      case 'prompt:trade':
        session.pendingInput = { kind: 'trade_mint' };
        await showDashboard(identity, 'trading', 'Manual trade started.', preferredMessageId, true);
        return;
      case 'prompt:set_max_buy':
        session.pendingInput = { kind: 'set_max_buy' };
        await showDashboard(identity, 'auto_buy', 'Send your new max buy size.', preferredMessageId, true);
        return;
      case 'prompt:set_daily_limit':
        session.pendingInput = { kind: 'set_daily_limit' };
        await showDashboard(identity, 'auto_buy', 'Send your new daily buy limit.', preferredMessageId, true);
        return;
      case 'prompt:set_min_score':
        session.pendingInput = { kind: 'set_min_score' };
        await showDashboard(identity, 'auto_buy', 'Send your new minimum score.', preferredMessageId, true);
        return;
      case 'prompt:set_take_profit':
        session.pendingInput = { kind: 'set_take_profit' };
        await showDashboard(identity, 'auto_sell', 'Send your new take-profit percent.', preferredMessageId, true);
        return;
      case 'prompt:set_stop_loss':
        session.pendingInput = { kind: 'set_stop_loss' };
        await showDashboard(identity, 'auto_sell', 'Send your new stop-loss percent.', preferredMessageId, true);
        return;
      case 'prompt:set_slippage':
        session.pendingInput = { kind: 'set_slippage' };
        await showDashboard(identity, 'settings', 'Send your new slippage value.', preferredMessageId, true);
        return;
      case 'prompt:set_priority':
        session.pendingInput = { kind: 'set_priority' };
        await showDashboard(identity, 'settings', 'Send your new priority fee in SOL.', preferredMessageId, true);
        return;
      case 'prompt:withdraw':
        session.pendingInput = { kind: 'withdraw_destination' };
        await showDashboard(identity, 'wallet', 'Withdrawal flow started.', preferredMessageId, true);
        return;
      case 'act:toggle_auto_buy': {
        const settings = await getUserSettings(identity.walletContext.userId);
        const nextValue = !settings.auto_buy_enabled;
        await updateUserSettings(identity.walletContext.userId, { autoBuyEnabled: nextValue });
        await audit(identity, 'settings.auto_buy_enabled', { value: nextValue });
        await showDashboard(identity, 'auto_buy', `Auto Buy is now ${nextValue ? 'ON' : 'OFF'}.`, preferredMessageId);
        return;
      }
      case 'act:toggle_auto_sell': {
        const settings = await getUserSettings(identity.walletContext.userId);
        const nextValue = !settings.auto_sell_enabled;
        await updateUserSettings(identity.walletContext.userId, { autoSellEnabled: nextValue });
        await audit(identity, 'settings.auto_sell_enabled', { value: nextValue });
        await showDashboard(identity, 'auto_sell', `Auto Sell is now ${nextValue ? 'ON' : 'OFF'}.`, preferredMessageId);
        return;
      }
      case 'act:toggle_turbo': {
        const settings = await getUserSettings(identity.walletContext.userId);
        const nextValue = !settings.degen_turbo_enabled;
        await updateUserSettings(identity.walletContext.userId, { degenTurboEnabled: nextValue });
        await audit(identity, 'settings.degen_turbo_enabled', { value: nextValue });
        await showDashboard(identity, 'safety', `Turbo Guard is now ${nextValue ? 'ON' : 'OFF'}.`, preferredMessageId);
        return;
      }
      case 'act:degen_preset':
        await updateUserSettings(identity.walletContext.userId, {
          minScore: DEGEN_MIN_SCORE,
          dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
          slippageBps: DEGEN_SLIPPAGE_BPS,
          priorityFeeLamports: Math.floor(DEGEN_PRIORITY_SOL * LAMPORTS_PER_SOL),
          degenTurboEnabled: true
        });
        await audit(identity, 'settings.degenmode_applied', {
          minScore: DEGEN_MIN_SCORE,
          dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
          slippageBps: DEGEN_SLIPPAGE_BPS,
          prioritySol: DEGEN_PRIORITY_SOL
        });
        await showDashboard(identity, 'auto_buy', 'Degen preset applied successfully.', preferredMessageId);
        return;
      case 'act:source_sniper':
        if (!config.enableSniperWorker) {
          await showDashboard(
            identity,
            'sources',
            'Launch Sniper is paused on this deployment profile. Use Copy Trade, or move to a stronger hosting profile.',
            preferredMessageId
          );
          return;
        }
        await updateSourceMode(identity, ['pumpfun', 'dexscreener'], 'Signal mode set to Launch Sniper.', preferredMessageId);
        return;
      case 'act:source_copy':
        await updateSourceMode(identity, ['copytrade'], 'Signal mode set to Copy Trade only.', preferredMessageId);
        return;
      case 'act:source_hybrid':
        if (!config.enableSniperWorker) {
          await showDashboard(
            identity,
            'sources',
            'Hybrid depends on sniper feeds. On this deployment the sniper side is paused, so Hybrid is not available.',
            preferredMessageId
          );
          return;
        }
        await updateSourceMode(identity, ['pumpfun', 'dexscreener', 'copytrade'], 'Signal mode set to Hybrid.', preferredMessageId);
        return;
      case 'act:source_all':
        if (!config.enableSniperWorker) {
          await showDashboard(
            identity,
            'sources',
            'All Sources includes sniper feeds. Those feeds are paused on this deployment profile.',
            preferredMessageId
          );
          return;
        }
        await updateSourceMode(identity, ['*'], 'Signal mode set to All Sources.', preferredMessageId);
        return;
      case 'act:withdraw_confirm':
        await confirmPendingWithdrawal(identity, undefined, preferredMessageId);
        return;
      case 'act:withdraw_cancel':
        pendingWithdrawConfirmByChat.delete(identity.chatId);
        await showDashboard(identity, 'wallet', 'Withdrawal request cancelled.', preferredMessageId);
        return;
      case 'act:export_confirm': {
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
        await showDashboard(identity, 'wallet', 'Private key sent in a separate message.', preferredMessageId);
        return;
      }
      default:
        await showDashboard(identity, 'home', 'That action is not available yet.', preferredMessageId);
        return;
  }
}

function getCommandAndArgs(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { command: '', args: [] };
  }
  const [command, ...args] = trimmed.split(/\s+/);
  return { command: command.toLowerCase(), args };
}

async function handleCommand(update: TelegramUpdate) {
  const rawText = update.message?.text?.trim();
  if (!rawText) {
    return;
  }

  const identity = await getIdentity(update);
  if (!identity) {
    return;
  }

  const session = getDashboardSession(identity.chatId);
  const { command, args } = getCommandAndArgs(rawText);

  switch (command) {
    case '/start':
      return showStartExperience(update);
    case '/menu':
      return showDashboard(identity, 'home');
    case '/wallet':
      return showDashboard(identity, 'wallet');
    case '/status':
      return showDashboard(identity, 'analytics');
    case '/help':
      return showDashboard(identity, 'support');
    case '/close':
      return closeDashboard(identity);
    case '/trade':
    case '/buy':
      if (!args.length) {
        session.pendingInput = { kind: 'trade_mint' };
        return showDashboard(identity, 'trading', 'Manual trade started.', undefined, true);
      }
      return handleManualTradeCommand(identity, args);
    case '/enable':
      await updateUserSettings(identity.walletContext.userId, { autoBuyEnabled: true });
      await audit(identity, 'settings.auto_buy_enabled', { value: true });
      return showDashboard(identity, 'auto_buy', 'Auto Buy enabled.');
    case '/disable':
      await updateUserSettings(identity.walletContext.userId, { autoBuyEnabled: false });
      await audit(identity, 'settings.auto_buy_enabled', { value: false });
      return showDashboard(identity, 'auto_buy', 'Auto Buy disabled.');
    case '/enableexit':
      await updateUserSettings(identity.walletContext.userId, { autoSellEnabled: true });
      await audit(identity, 'settings.auto_sell_enabled', { value: true });
      return showDashboard(identity, 'auto_sell', 'Auto Sell enabled.');
    case '/disableexit':
      await updateUserSettings(identity.walletContext.userId, { autoSellEnabled: false });
      await audit(identity, 'settings.auto_sell_enabled', { value: false });
      return showDashboard(identity, 'auto_sell', 'Auto Sell disabled.');
    case '/settings':
      return showDashboard(identity, 'settings');
    case '/setsize':
    case '/setstake':
      if (!args.length) {
        session.pendingInput = { kind: 'set_max_buy' };
        return showDashboard(identity, 'auto_buy', 'Send your new max buy size.', undefined, true);
      }
      return handleSetNumericCommand(identity, 'maxBuySol', args[0], 'auto_buy', `Minimum is ${MIN_BUY_SOL} SOL.`, MIN_BUY_SOL, 'settings.max_buy_sol', 'Max buy size');
    case '/setdaily':
      if (!args.length) {
        session.pendingInput = { kind: 'set_daily_limit' };
        return showDashboard(identity, 'auto_buy', 'Send your new daily limit.', undefined, true);
      }
      return handleSetNumericCommand(identity, 'dailyLimitSol', args[0], 'auto_buy', 'Daily limit must be positive.', 0.0000001, 'settings.daily_limit_sol', 'Daily limit');
    case '/setminscore':
      if (!args.length) {
        session.pendingInput = { kind: 'set_min_score' };
        return showDashboard(identity, 'auto_buy', 'Send your new minimum score.', undefined, true);
      }
      return handleSetMinScoreCommand(identity, args[0]);
    case '/degenmode':
      await updateUserSettings(identity.walletContext.userId, {
        minScore: DEGEN_MIN_SCORE,
        dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
        slippageBps: DEGEN_SLIPPAGE_BPS,
        priorityFeeLamports: Math.floor(DEGEN_PRIORITY_SOL * LAMPORTS_PER_SOL),
        degenTurboEnabled: true
      });
      await audit(identity, 'settings.degenmode_applied', {
        minScore: DEGEN_MIN_SCORE,
        dailyLimitSol: DEGEN_DAILY_LIMIT_SOL,
        slippageBps: DEGEN_SLIPPAGE_BPS,
        prioritySol: DEGEN_PRIORITY_SOL
      });
      return showDashboard(identity, 'auto_buy', 'Degen preset applied.');
    case '/turboon':
      await updateUserSettings(identity.walletContext.userId, { degenTurboEnabled: true });
      await audit(identity, 'settings.degen_turbo_enabled', { value: true });
      return showDashboard(identity, 'safety', 'Turbo Guard enabled.');
    case '/turbooff':
      await updateUserSettings(identity.walletContext.userId, { degenTurboEnabled: false });
      await audit(identity, 'settings.degen_turbo_enabled', { value: false });
      return showDashboard(identity, 'safety', 'Turbo Guard disabled.');
    case '/turbostatus':
      return showDashboard(identity, 'safety');
    case '/settp':
      if (!args.length) {
        session.pendingInput = { kind: 'set_take_profit' };
        return showDashboard(identity, 'auto_sell', 'Send your new take-profit percent.', undefined, true);
      }
      return handleSetNumericCommand(identity, 'takeProfitPct', args[0], 'auto_sell', 'Take profit must be positive.', 0.0000001, 'settings.take_profit_pct', 'Take profit', '%');
    case '/setsl':
      if (!args.length) {
        session.pendingInput = { kind: 'set_stop_loss' };
        return showDashboard(identity, 'auto_sell', 'Send your new stop-loss percent.', undefined, true);
      }
      return handleSetNumericCommand(identity, 'stopLossPct', args[0], 'auto_sell', 'Stop loss must be positive.', 0.0000001, 'settings.stop_loss_pct', 'Stop loss', '%');
    case '/setslippage':
      if (!args.length) {
        session.pendingInput = { kind: 'set_slippage' };
        return showDashboard(identity, 'settings', 'Send your new slippage.', undefined, true);
      }
      return handleSetSlippageCommand(identity, args[0]);
    case '/setpriority':
      if (!args.length) {
        session.pendingInput = { kind: 'set_priority' };
        return showDashboard(identity, 'settings', 'Send your new priority fee in SOL.', undefined, true);
      }
      return handleSetPriorityCommand(identity, args[0]);
    case '/subscribe': {
      if (!args.length) {
        return showDashboard(identity, 'sources');
      }
      const sources = parseSourcesArg(args);
      if (!sources.length) {
        return showDashboard(identity, 'sources', 'Provide a comma-separated source list or use the buttons.');
      }
      await updateUserSettings(identity.walletContext.userId, { allowedSources: sources });
      await audit(identity, 'settings.allowed_sources', { value: sources });
      return showDashboard(identity, 'sources', `Sources updated to ${sources.join(', ')}.`);
    }
    case '/sources':
      return showDashboard(identity, 'sources');
    case '/positions':
      return showDashboard(identity, 'analytics_positions');
    case '/sniper':
      return showDashboard(identity, 'sniper');
    case '/copytrade':
      return showDashboard(identity, 'sources', 'Use the source profiles below to control copy-trade routing.');
    case '/deposits':
      return showDashboard(identity, 'wallet_deposits');
    case '/withdraw':
    case '/withdrawwizard':
      if (!args.length) {
        session.pendingInput = { kind: 'withdraw_destination' };
        return showDashboard(identity, 'wallet', 'Withdrawal flow started.', undefined, true);
      }
      return handleDirectWithdrawRequest(identity, args);
    case '/confirmwithdraw':
      return confirmPendingWithdrawal(identity, String(args[0] ?? ''));
    case '/withdrawals':
      return showDashboard(identity, 'wallet_withdrawals');
    case '/report':
      return showDashboard(identity, 'analytics_report');
    case '/whytrade':
      return showDashboard(identity, 'analytics_decision');
    case '/exportkey':
      if (args[0]?.toUpperCase() !== 'CONFIRM') {
        return showDashboard(identity, 'wallet_export_confirm');
      }
      return handleExportKeyCommand(identity);
    default:
      return showDashboard(identity, 'support', 'Use the dashboard buttons below to navigate.');
  }
}

async function handleSetNumericCommand(
  identity: BotIdentity,
  key: 'maxBuySol' | 'dailyLimitSol' | 'takeProfitPct' | 'stopLossPct',
  rawValue: string,
  view: DashboardView,
  errorMessage: string,
  minExclusive: number,
  auditAction: string,
  label: string,
  suffix = ' SOL'
) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < minExclusive) {
    return showDashboard(identity, view, errorMessage);
  }

  await updateUserSettings(identity.walletContext.userId, { [key]: value });
  await audit(identity, auditAction, { value });
  return showDashboard(identity, view, `${label} updated to ${value}${suffix}.`);
}

async function handleSetMinScoreCommand(identity: BotIdentity, rawValue: string) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return showDashboard(identity, 'auto_buy', 'Minimum score must be between 0 and 100.');
  }

  await updateUserSettings(identity.walletContext.userId, { minScore: value });
  await audit(identity, 'settings.min_score', { value });
  return showDashboard(identity, 'auto_buy', `Minimum score updated to ${value}.`);
}

async function handleSetSlippageCommand(identity: BotIdentity, rawValue: string) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 50 || value > 5000) {
    return showDashboard(identity, 'settings', 'Slippage must be between 50 and 5000 bps.');
  }

  await updateUserSettings(identity.walletContext.userId, { slippageBps: value });
  await audit(identity, 'settings.slippage_bps', { value });
  return showDashboard(identity, 'settings', `Slippage updated to ${value} bps.`);
}

async function handleSetPriorityCommand(identity: BotIdentity, rawValue: string) {
  const solValue = Number(rawValue);
  if (!Number.isFinite(solValue) || solValue < 0) {
    return showDashboard(identity, 'settings', 'Priority fee must be zero or higher.');
  }

  const lamports = Math.floor(solValue * LAMPORTS_PER_SOL);
  await updateUserSettings(identity.walletContext.userId, { priorityFeeLamports: lamports });
  await audit(identity, 'settings.priority_fee_lamports', { value: lamports });
  return showDashboard(identity, 'settings', `Priority fee updated to ${solValue} SOL.`);
}

async function handleManualTradeCommand(identity: BotIdentity, args: string[]) {
  const [mint, amountRaw, slippageRaw, tpRaw, slRaw, idempotencyRaw] = args;
  if (!mint) {
    return showDashboard(identity, 'trading', 'Provide a token mint or use the guided New Trade flow.');
  }

  try {
    new PublicKey(mint);
  } catch {
    return showDashboard(identity, 'trading', 'That token mint was not valid.');
  }

  const amountSol = amountRaw ? Number(amountRaw) : undefined;
  const slippageBps = slippageRaw ? Number(slippageRaw) : undefined;
  const takeProfitPct = tpRaw ? Number(tpRaw) : undefined;
  const stopLossPct = slRaw ? Number(slRaw) : undefined;

  if (amountSol !== undefined && (!Number.isFinite(amountSol) || amountSol < MIN_BUY_SOL)) {
    return showDashboard(identity, 'trading', `Trade amount must be at least ${MIN_BUY_SOL} SOL.`);
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
  return showDashboard(identity, 'trading', `Trade queued: ${result.amountSol} SOL on ${mint}.`);
}

async function handleDirectWithdrawRequest(identity: BotIdentity, args: string[]) {
  const [destination, amountRaw] = args;
  const amount = Number(amountRaw);
  if (!destination || !Number.isFinite(amount) || amount <= 0) {
    return showDashboard(identity, 'wallet', 'Use `/withdraw DESTINATION 0.1` or the guided wallet flow.');
  }

  try {
    new PublicKey(destination);
  } catch {
    return showDashboard(identity, 'wallet', 'That withdrawal destination was not valid.');
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
  return showDashboard(identity, 'wallet_withdraw_confirm', 'Review and confirm the withdrawal below.');
}

async function handleExportKeyCommand(identity: BotIdentity) {
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
  return showDashboard(identity, 'wallet', 'Private key sent in a separate message.');
}

export async function handleIncomingUpdate(update: TelegramUpdate) {
  if (isCallbackUpdate(update)) {
    return handleCallbackQuery(update);
  }

  const rawText = update.message?.text?.trim();
  if (!rawText) {
    return;
  }

  if (!rawText.startsWith('/')) {
    const handledPending = await processPendingInput(update, rawText);
    if (handledPending) {
      return;
    }

    const identity = await getIdentity(update);
    if (identity) {
      await showDashboard(identity, 'home', 'Use the dashboard buttons below to continue.');
    }
    return;
  }

  return handleCommand(update);
}

export async function startTelegramBot(signal?: AbortSignal) {
  await setCommands();
  if (config.telegramWebhookUrl) {
    await setWebhook(config.telegramWebhookUrl, config.telegramWebhookSecret || undefined);
    logger.info('telegram_webhook_enabled', { url: config.telegramWebhookUrl });

    while (!signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return;
  }

  await deleteWebhook(false).catch((error: any) => {
    logger.error('telegram_delete_webhook_failed', { message: error.message });
  });
  let offset = 0;

  while (!signal?.aborted) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        if (signal?.aborted) {
          break;
        }
        offset = update.update_id + 1;
        try {
          await handleIncomingUpdate(update);
        } catch (error: any) {
          logger.error('telegram_update_handle_error', {
            updateId: update.update_id,
            message: error.message
          });

          const chatId = getUpdateChatId(update);
          if (chatId) {
            await sendMessage(
              chatId,
              'Something went wrong while handling that action. Send /menu to reopen the dashboard.'
            ).catch(() => undefined);
          }
        }
      }
    } catch (error: any) {
      if (signal?.aborted) {
        break;
      }
      if (error.message === 'telegram_http_409') {
        logger.info('telegram_poll_conflict', {
          message: 'Another bot polling session is active for this token. Backing off before retrying.'
        });
        await new Promise((resolve) => setTimeout(resolve, 10000));
        continue;
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
