import { Inject, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { KPAX_MODULE_OPTIONS } from '../kpax.module-definition';
import {
  KpaxModuleOptions,
  resolveKpaxOptions,
  ResolvedKpaxModuleOptions,
} from '../interfaces/kpax-module-options.interface';
import { KpaxConnection } from '../interfaces/kpax-connection.interface';
import { KpaxTokenService } from '../auth/kpax-token.service';
import { KpaxApiError, KpaxAuthError } from '../errors/kpax.errors';
import { KpaxClient } from './kpax.client';
import {
  kpaxFingerprint,
  normalizeKpaxConnection,
} from './kpax-connection.util';

export interface KpaxConnectionTestResult {
  ok: boolean;
  /** 'auth' = token endpoint refused the credentials; 'api' = token OK but the API call failed. */
  stage?: 'config' | 'auth' | 'api';
  status?: number;
  message?: string;
  latencyMs: number;
  /** /server/status payload when ok. */
  server?: unknown;
}

/**
 * Builds KpaxClients. Most code should use KpaxConnectionRegistry (stored
 * connections); use the factory for ad-hoc connections, e.g. testing
 * credentials an admin typed in before saving them.
 */
@Injectable()
export class KpaxClientFactory {
  readonly options: ResolvedKpaxModuleOptions;
  /** fingerprint -> client, least-recently-used first. Ad-hoc connections only. */
  private readonly adHoc = new Map<string, KpaxClient>();

  constructor(
    private readonly http: HttpService,
    private readonly tokens: KpaxTokenService,
    @Inject(KPAX_MODULE_OPTIONS) options: KpaxModuleOptions,
  ) {
    this.options = resolveKpaxOptions(options);
  }

  /** Cached client for an explicit connection (validated and normalised). */
  forConnection(connection: KpaxConnection): KpaxClient {
    const conn = normalizeKpaxConnection(connection);
    const fp = this.fingerprint(conn);
    const cached = this.adHoc.get(fp);
    if (cached) {
      this.adHoc.delete(fp);
      this.adHoc.set(fp, cached);
      return cached;
    }
    const client = this.create(conn);
    this.adHoc.set(fp, client);
    while (this.adHoc.size > this.options.maxCachedConnections) {
      const oldest = this.adHoc.keys().next().value as string;
      this.adHoc.delete(oldest);
      this.tokens.forget(oldest);
    }
    return client;
  }

  /** New, uncached client. The registry owns the clients it creates this way. */
  create(connection: KpaxConnection): KpaxClient {
    const conn = normalizeKpaxConnection(connection);
    return new KpaxClient(
      Object.freeze({ ...conn }),
      this.http.axiosRef,
      this.tokens,
      this.options,
    );
  }

  /** Drop the cached token for a connection that is no longer used. */
  release(connection: KpaxConnection): void {
    const fp = this.fingerprint(normalizeKpaxConnection(connection));
    this.adHoc.delete(fp);
    this.tokens.forget(fp);
  }

  /**
   * Checks credentials end to end: fetches a token, then calls /server/status.
   * Never throws; the result says which stage failed. Note that a missing
   * `server:read` scope shows up as an 'api' failure with status 401.
   */
  async testConnection(
    connection: KpaxConnection,
  ): Promise<KpaxConnectionTestResult> {
    const started = Date.now();
    let conn: KpaxConnection;
    try {
      conn = normalizeKpaxConnection(connection);
    } catch (e) {
      return {
        ok: false,
        stage: 'config',
        message: (e as Error).message,
        latencyMs: 0,
      };
    }
    const client = this.create(conn);
    try {
      const server = await client.serverStatus();
      return { ok: true, latencyMs: Date.now() - started, server };
    } catch (e) {
      const latencyMs = Date.now() - started;
      if (e instanceof KpaxAuthError) {
        return {
          ok: false,
          stage: 'auth',
          status: e.status,
          message: e.message,
          latencyMs,
        };
      }
      if (e instanceof KpaxApiError) {
        return {
          ok: false,
          stage: 'api',
          status: e.status,
          message: e.message,
          latencyMs,
        };
      }
      return {
        ok: false,
        stage: 'api',
        message: (e as Error).message,
        latencyMs,
      };
    } finally {
      this.tokens.forget(this.fingerprint(conn));
    }
  }

  fingerprint(conn: KpaxConnection): string {
    return kpaxFingerprint(conn, this.options.defaultScopes);
  }
}
