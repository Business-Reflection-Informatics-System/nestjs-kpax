import { createHash } from 'crypto';
import { KpaxConnection } from '../interfaces/kpax-connection.interface';
import { KpaxConfigurationError } from '../errors/kpax.errors';

/** Validates and normalises a connection (trims, strips trailing slashes and /api/v1). */
export function normalizeKpaxConnection(
  connection: KpaxConnection,
): KpaxConnection {
  if (!connection) throw new KpaxConfigurationError('KPAX connection is empty');
  const host = (connection.host ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new KpaxConfigurationError(`KPAX host is not a valid URL: "${host}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new KpaxConfigurationError(`KPAX host must be http(s): "${host}"`);
  }
  const clientId = (connection.clientId ?? '').trim();
  const clientSecret = (connection.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new KpaxConfigurationError(
      `KPAX connection for ${host} is missing clientId or clientSecret`,
    );
  }
  return {
    host,
    clientId,
    clientSecret,
    scopes: connection.scopes?.map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * Stable identity of a connection. Hashes the secret so it never sits in a map
 * key or log line in clear text.
 */
export function kpaxFingerprint(
  connection: KpaxConnection,
  defaultScopes: string[],
): string {
  const scopes = (connection.scopes?.length ? connection.scopes : defaultScopes)
    .slice()
    .sort()
    .join(' ');
  return createHash('sha256')
    .update(
      [
        connection.host,
        connection.clientId,
        connection.clientSecret,
        scopes,
      ].join('\u0000'),
    )
    .digest('hex');
}
