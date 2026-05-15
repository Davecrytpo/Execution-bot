import crypto from 'crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = config.custodyMasterKey;
  if (!raw) {
    throw new Error('CUSTODY_MASTER_KEY is required');
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const asBase64 = Buffer.from(raw, 'base64');
    if (asBase64.length === 32) {
      return asBase64;
    }
  } catch {
    // Ignore and derive from raw string.
  }

  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    encrypted: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptSecret(encrypted: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
}
