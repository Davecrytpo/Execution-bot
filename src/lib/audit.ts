import { query } from './db.js';
import { logger } from './logger.js';

export async function logAuditAction(params: {
  userId?: string | null;
  chatId?: number | string | null;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await query(
      `
      INSERT INTO audit_logs (user_id, chat_id, action, metadata)
      VALUES ($1, $2, $3, $4)
      `,
      [params.userId ?? null, params.chatId ?? null, params.action, params.metadata ?? {}]
    );
  } catch (error: any) {
    logger.error('audit_log_failed', { action: params.action, message: error.message });
  }
}
