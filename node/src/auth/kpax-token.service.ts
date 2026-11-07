import { Inject, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { KPAX_MODULE_OPTIONS } from '../kpax.module-definition';
import {
  KpaxModuleOptions,
  resolveKpaxOptions,
  ResolvedKpaxModuleOptions,
} from '../interfaces/kpax-module-options.interface';
import { KpaxConnection } from '../interfaces/kpax-connection.interface';
import { KpaxAuthError } from '../errors/kpax.errors';
import { kpaxFingerprint } from '../client/kpax-connection.util';

interface CachedToken {
  token: string | null;
  expiresAt: number;
  inflight: Promise<string> | null;
}

/**
 * OAuth2 client-credentials tokens for KPAX, cached per distinct connection
 * (host + client id + secret + scopes). A changed secret or URL is a different
 * fingerprint, so it gets a fresh token; the stale entry is simply never used
 * again and is dropped by forget()/eviction.
 */
@Injectable()
export class KpaxTokenService {
  private readonly cache = new Map<string, CachedToken>();
  private readonly opts: ResolvedKpaxModuleOptions;

  constructor(
    private readonly http: HttpService,
    @Inject(KPAX_MODULE_OPTIONS) options: KpaxModuleOptions,
  ) {
    this.opts = resolveKpaxOptions(options);
  }

  async getToken(connection: KpaxConnection): Promise<string> {
    const key = kpaxFingerprint(connection, this.opts.defaultScopes);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { token: null, expiresAt: 0, inflight: null };
      this.cache.set(key, entry);
    }
    if (entry.token && Date.now() < entry.expiresAt) return entry.token;
    if (!entry.inflight) {
      const e = entry;
      e.inflight = this.fetchToken(connection, e).finally(() => {
        e.inflight = null;
      });
    }
    return entry.inflight as Promise<string>;
  }

  /** Drop the cached token so the next call fetches a new one (e.g. after a 401). */
  invalidate(connection: KpaxConnection): void {
    const entry = this.cache.get(
      kpaxFingerprint(connection, this.opts.defaultScopes),
    );
    if (entry) {
      entry.token = null;
      entry.expiresAt = 0;
    }
  }

  /** Remove a connection's entry entirely (used when the factory evicts it). */
  forget(fingerprint: string): void {
    this.cache.delete(fingerprint);
  }

  private async fetchToken(
    connection: KpaxConnection,
    entry: CachedToken,
  ): Promise<string> {
    const scopes = connection.scopes?.length
      ? connection.scopes
      : this.opts.defaultScopes;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: connection.clientId,
      client_secret: connection.clientSecret,
      scope: scopes.join(' '),
    });

    let res;
    try {
      res = await this.http.axiosRef.request({
        method: 'POST',
        url: `${connection.host}/oauth/token`,
        data: form.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeout: this.opts.timeoutMs,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new KpaxAuthError(0, connection.host, {
        message: (err as Error).message,
      });
    }

    if (res.status < 200 || res.status >= 300) {
      throw new KpaxAuthError(res.status, connection.host, res.data);
    }
    const body = res.data as { access_token?: string; expires_in?: number };
    if (!body || typeof body.access_token !== 'string') {
      throw new KpaxAuthError(res.status, connection.host, {
        message: 'Token response did not include access_token',
      });
    }

    const ttlMs = (body.expires_in ?? 3600) * 1000;
    entry.token = body.access_token;
    entry.expiresAt =
      Date.now() +
      Math.max(ttlMs - this.opts.tokenRefreshSkewSeconds * 1000, 0);
    return entry.token;
  }
}
