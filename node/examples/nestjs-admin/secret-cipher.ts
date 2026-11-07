import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/**
 * Minimal AES-256-GCM helper for secrets at rest. Replace with your app's own
 * encryption service if it has one. Key from KPAX_SECRET_KEY (any length; it is
 * hashed to 32 bytes). Rotating the key makes stored secrets undecryptable.
 */
@Injectable()
export class SecretCipher {
  private readonly key = createHash('sha256')
    .update(process.env.KPAX_SECRET_KEY ?? '')
    .digest();

  encrypt(plain: string): string {
    if (!process.env.KPAX_SECRET_KEY) {
      throw new Error('KPAX_SECRET_KEY is not set');
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  }

  decrypt(payload: string): string | null {
    try {
      if (!payload.startsWith('v1:')) return null;
      const buf = Buffer.from(payload.slice(3), 'base64');
      const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString(
        'utf8',
      );
    } catch {
      return null;
    }
  }
}
