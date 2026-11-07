import { Logger } from '@nestjs/common';
import type { AxiosInstance, AxiosResponse } from 'axios';
import { KpaxConnection } from '../interfaces/kpax-connection.interface';
import { ResolvedKpaxModuleOptions } from '../interfaces/kpax-module-options.interface';
import { KpaxTokenService } from '../auth/kpax-token.service';
import { KpaxApiError } from '../errors/kpax.errors';
import { kpaxCollect, kpaxPaginate } from './kpax-pagination';
import {
  KpaxAccount,
  KpaxAlertHistoryEvent,
  KpaxAttributeRef,
  KpaxAttributeValue,
  KpaxCallOptions,
  KpaxCartridge,
  KpaxDevice,
  KpaxDeviceAttributeFilter,
  KpaxDeviceDailySnapshot,
  KpaxDeviceFull,
  KpaxDeviceSearchResult,
  KpaxDeviceSort,
  KpaxDeviceSupplyCycle,
  KpaxDeviceVolumes,
  KpaxHttpMethod,
  KpaxOperation,
  KpaxPage,
  KpaxParentScope,
  KpaxParentType,
  KpaxPathsFor,
  KpaxResponseOf,
  KpaxSearchFilter,
  KpaxVolumeInterval,
} from '../types/kpax.types';

const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']);

export interface KpaxRateLimit {
  limit?: number;
  remaining?: number;
  /** Unix seconds when the window resets. */
  reset?: number;
}

/**
 * Client bound to ONE KPAX connection. Don't construct it directly — get it
 * from KpaxClientFactory, which builds a new one whenever the resolved URL or
 * credentials change.
 *
 * - `call()` reaches every operation in the spec with types.
 * - The named methods cover the day-to-day reads, throw KpaxApiError on
 *   failure and walk pagination where that makes sense.
 *
 * KPAX treats all dates as UTC.
 */
export class KpaxClient {
  private readonly logger = new Logger(KpaxClient.name);
  private blockedUntil = 0;
  /** Last rate-limit headers KPAX returned for this connection. */
  lastRateLimit: KpaxRateLimit | null = null;

  constructor(
    readonly connection: Readonly<KpaxConnection>,
    private readonly http: AxiosInstance,
    private readonly tokens: KpaxTokenService,
    private readonly opts: ResolvedKpaxModuleOptions,
  ) {}

  get host(): string {
    return this.connection.host;
  }

  // ======================================================================
  // Typed access to every endpoint
  // ======================================================================

  /**
   * Typed call to any operation in the KPAX spec, e.g.
   *   client.call('get', '/rules/executions-history', { query: { rule_id: 3, page: 2 } })
   */
  async call<M extends KpaxHttpMethod, P extends KpaxPathsFor<M>>(
    method: M,
    path: P,
    options: KpaxCallOptions<KpaxOperation<P, M>> = {},
  ): Promise<KpaxResponseOf<KpaxOperation<P, M>>> {
    const url = interpolate(
      path as string,
      options.path as Record<string, unknown>,
    );
    let data: unknown = options.body;
    const headers: Record<string, string> = {};
    if (options.form) {
      data = new URLSearchParams(options.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.send(
      method.toUpperCase(),
      url,
      options.query as Record<string, unknown>,
      data,
      headers,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new KpaxApiError(res.status, method.toUpperCase(), url, res.data);
    }
    return (res.status === 204 ? undefined : res.data) as KpaxResponseOf<
      KpaxOperation<P, M>
    >;
  }

  // ======================================================================
  // Server / hierarchy / accounts
  // ======================================================================

  /** Cheap connectivity + credentials check. Needs server:read. */
  serverStatus() {
    return this.call('get', '/server/status');
  }

  /** Accounts, agents, devices and dynamic groups under a container (default: the client's own level). */
  hierarchy(scope?: { objectType: KpaxParentType; objectId: number }) {
    return this.call('get', '/hierarchy-elements', {
      query: scope
        ? { object_type: scope.objectType, object_id: scope.objectId }
        : {},
    });
  }

  listAccounts(
    opts: { parentId?: number; withChildren?: boolean; page?: number } = {},
  ): Promise<KpaxPage<KpaxAccount>> {
    return this.call('get', '/accounts', {
      query: {
        ...(opts.parentId !== undefined && {
          parent_type: 'account' as const,
          parent_id: opts.parentId,
          with_children: opts.withChildren,
        }),
        page: opts.page,
      },
    }) as Promise<KpaxPage<KpaxAccount>>;
  }

  iterateAccounts(opts: { parentId?: number; withChildren?: boolean } = {}) {
    return kpaxPaginate<KpaxAccount>((page) =>
      this.listAccounts({ ...opts, page }),
    );
  }

  getAccount(accountId: number) {
    return this.call('get', '/accounts/{account_id}', {
      path: { account_id: accountId },
    });
  }

  // ======================================================================
  // Devices
  // ======================================================================

  /** One page of devices. perPage (≤1000) only applies to the core schema. */
  listDevices(
    opts: {
      scope?: KpaxParentScope;
      schema?: 'core' | 'full';
      page?: number;
      perPage?: number;
      sort?: KpaxDeviceSort;
    } = {},
  ): Promise<KpaxPage<KpaxDevice>> {
    const schema = opts.schema ?? 'core';
    return this.call('get', '/devices', {
      query: {
        ...scopeQuery(opts.scope),
        schema,
        sort: opts.sort,
        page: opts.page,
        per_page: schema === 'core' ? opts.perPage : undefined,
      },
    }) as Promise<KpaxPage<KpaxDevice>>;
  }

  /** Streams every device across all pages (core schema: 1000 per page). */
  iterateDevices(
    opts: {
      scope?: KpaxParentScope;
      schema?: 'core' | 'full';
      perPage?: number;
      sort?: KpaxDeviceSort;
    } = {},
  ) {
    const perPage =
      opts.perPage ?? ((opts.schema ?? 'core') === 'core' ? 1000 : undefined);
    return kpaxPaginate<KpaxDevice>((page) =>
      this.listDevices({ ...opts, perPage, page }),
    );
  }

  getDevice(deviceId: number): Promise<KpaxDeviceFull> {
    return this.call('get', '/devices/{device_id}', {
      path: { device_id: deviceId },
    });
  }

  /** Partial serial search (min 5 chars), all pages. Use findDeviceBySerial for an exact match. */
  async searchDevicesBySerial(
    serial: string,
    opts: { scope?: KpaxParentScope; schema?: 'core' | 'full' } = {},
  ): Promise<KpaxDevice[]> {
    const s = (serial ?? '').trim();
    if (s.length < 5) {
      throw new RangeError(
        'KPAX serial-number search needs at least 5 characters',
      );
    }
    return kpaxCollect(
      kpaxPaginate<KpaxDevice>(
        (page) =>
          this.call('get', '/devices/search-by-serial-number', {
            query: {
              serial_number: s,
              ...scopeQuery(opts.scope),
              schema: opts.schema,
              page,
            },
          }) as Promise<KpaxPage<KpaxDevice>>,
      ),
    );
  }

  /**
   * Exact, case-insensitive serial match against both the effective serial and
   * the device-reported original. Null if none; throws if more than one device matches.
   */
  async findDeviceBySerial(
    serial: string,
    opts: { scope?: KpaxParentScope } = {},
  ): Promise<KpaxDevice | null> {
    const want = (serial ?? '').trim().toUpperCase();
    const hits = (await this.searchDevicesBySerial(want, opts)).filter((d) =>
      [d.serial_number, d.serial_number_origin].some(
        (v) => typeof v === 'string' && v.trim().toUpperCase() === want,
      ),
    );
    if (hits.length > 1) {
      throw new KpaxApiError(
        409,
        'GET',
        '/devices/search-by-serial-number',
        { matches: hits.map((h) => h.id) },
        `Serial ${want} matches ${hits.length} KPAX devices`,
      );
    }
    return hits[0] ?? null;
  }

  /**
   * POST /devices/search — the bulk meters/supplies read across a fleet.
   * Pick attributes from listDeviceAttributes(). Form-encoded per the spec.
   */
  searchDevices(opts: {
    scope?: KpaxParentScope;
    attributes?: KpaxAttributeRef[];
    filters?: KpaxSearchFilter[];
    attributesWithLastCheck?: boolean;
    profileIds?: number[];
    sort?: KpaxDeviceSort;
    page?: number;
    perPage?: number;
  }): Promise<KpaxPage<KpaxDeviceSearchResult>> {
    const form: Record<string, string> = {};
    if (opts.scope) {
      form.parent_type = opts.scope.parentType;
      form.parent_id = String(opts.scope.parentId);
      if (opts.scope.withChildren !== undefined) {
        form.with_children = opts.scope.withChildren ? '1' : '0';
      }
    }
    if (opts.attributes?.length)
      form.attributes = JSON.stringify(opts.attributes);
    if (opts.filters?.length) form.filters = JSON.stringify(opts.filters);
    if (opts.attributesWithLastCheck !== undefined) {
      form.attributes_with_last_check = opts.attributesWithLastCheck
        ? '1'
        : '0';
    }
    if (opts.profileIds?.length) form.profile_id = opts.profileIds.join(',');
    if (opts.sort) form.sort = opts.sort;
    if (opts.page !== undefined) form.page = String(opts.page);
    if (opts.perPage !== undefined) form.per_page = String(opts.perPage);

    return this.call('post', '/devices/search', { form }) as Promise<
      KpaxPage<KpaxDeviceSearchResult>
    >;
  }

  iterateDeviceSearch(
    opts: Omit<Parameters<KpaxClient['searchDevices']>[0], 'page'>,
  ) {
    return kpaxPaginate<KpaxDeviceSearchResult>((page) =>
      this.searchDevices({ ...opts, page }),
    );
  }

  /** Page volumes per interval. Dates are YYYY-MM-DD (UTC). */
  getDeviceVolumes(
    deviceId: number,
    opts: {
      interval?: KpaxVolumeInterval;
      startDate: string;
      endDate: string;
      volumeName?: NonNullable<
        KpaxCallOptions<
          KpaxOperation<'/devices/{device_id}/volumes', 'get'>
        >['query']
      >['volume_name'];
    },
  ): Promise<KpaxDeviceVolumes> {
    return this.call('get', '/devices/{device_id}/volumes', {
      path: { device_id: deviceId },
      query: {
        interval: opts.interval ?? 'daily',
        start_date: opts.startDate,
        end_date: opts.endDate,
        volume_name: opts.volumeName,
      },
    });
  }

  /** Daily snapshots of a device (meters, supplies, status). */
  getDeviceHistory(
    deviceId: number,
    opts: { startDate?: string; endDate?: string; sort?: 'asc' | 'desc' } = {},
  ): Promise<KpaxDeviceDailySnapshot[]> {
    return this.call('get', '/devices/{device_id}/history', {
      path: { device_id: deviceId },
      query: {
        start_date: opts.startDate,
        end_date: opts.endDate,
        sort: opts.sort,
      },
    }) as Promise<KpaxDeviceDailySnapshot[]>;
  }

  /** History of one attribute, e.g. { namespace: 'kpax.core.print.devices', name: 'engine_count' }. */
  getDeviceAttributeHistory(
    deviceId: number,
    attr: KpaxAttributeRef,
    opts: { startDate?: string; endDate?: string; sort?: 'asc' | 'desc' } = {},
  ): Promise<KpaxAttributeValue[]> {
    return this.call('get', '/devices/{device_id}/attributes/history', {
      path: { device_id: deviceId },
      query: {
        namespace: attr.namespace,
        name: attr.name,
        start_date: opts.startDate,
        end_date: opts.endDate,
        sort: opts.sort,
      },
    }) as Promise<KpaxAttributeValue[]>;
  }

  /** Toner replacement cycles for one cartridge colour. */
  getSupplyCycles(
    deviceId: number,
    cartridge: KpaxCartridge,
    nbCycles?: number,
  ): Promise<KpaxDeviceSupplyCycle[]> {
    return this.call('get', '/devices/{device_id}/supply-cycles', {
      path: { device_id: deviceId },
      query: { cartridge, nb_cycles: nbCycles },
    }) as Promise<KpaxDeviceSupplyCycle[]>;
  }

  /** Technical alert (status event) history for a device, all pages. */
  getTechnicalAlertHistory(
    deviceId: number,
    opts: { startDate?: string; endDate?: string; sort?: 'asc' | 'desc' } = {},
  ): Promise<KpaxAlertHistoryEvent[]> {
    return kpaxCollect(
      kpaxPaginate<KpaxAlertHistoryEvent>(
        (page) =>
          this.call(
            'get',
            '/devices/{device_id}/technical-status-events/history',
            {
              path: { device_id: deviceId },
              query: {
                start_date: opts.startDate,
                end_date: opts.endDate,
                sort: opts.sort,
                page,
              },
            },
          ) as Promise<KpaxPage<KpaxAlertHistoryEvent>>,
      ),
    );
  }

  /** Attribute catalogue — choose `attributes` for searchDevices() from here. */
  listDeviceAttributes(filter?: KpaxDeviceAttributeFilter, locale?: string) {
    return this.call('get', '/devices/attributes', {
      query: { filter, locale },
    });
  }

  listProfiles() {
    return this.call('get', '/profiles');
  }

  // ======================================================================
  // Transport
  // ======================================================================

  /**
   * Adds the bearer token, refreshes it once on 401, honours KPAX's rate-limit
   * headers, and retries transient failures. POST is retried only on 429,
   * where KPAX has explicitly not processed it.
   */
  private async send(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    data: unknown,
    extraHeaders: Record<string, string>,
  ): Promise<AxiosResponse> {
    const url = `${this.connection.host}/api/v1${path}`;
    let attempt = 0;
    let refreshedToken = false;

    for (;;) {
      const wait = this.blockedUntil - Date.now();
      if (wait > 0) await this.sleep(Math.min(wait, this.opts.maxDelayMs));

      const token = await this.tokens.getToken(this.connection);
      let res: AxiosResponse;
      try {
        res = await this.http.request({
          method,
          url,
          params: compact(query),
          data,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
          },
          timeout: this.opts.timeoutMs,
          validateStatus: () => true,
        });
      } catch (err) {
        if (IDEMPOTENT.has(method) && attempt < this.opts.maxRetries) {
          const delay = this.backoff(attempt++);
          this.logger.warn(
            `KPAX ${method} ${path} network error (${
              (err as Error).message
            }); retry #${attempt} in ${Math.round(delay)}ms`,
          );
          await this.sleep(delay);
          continue;
        }
        throw new KpaxApiError(0, method, path, {
          message: (err as Error).message,
        });
      }

      this.trackRateLimit(res.headers as Record<string, unknown>);

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.tokens.invalidate(this.connection);
        continue;
      }

      if (res.status === 429 && attempt < this.opts.maxRetries) {
        const delay = Math.min(
          this.retryAfterMs(res.headers as Record<string, unknown>) ??
            this.backoff(attempt),
          this.opts.maxDelayMs,
        );
        attempt++;
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delay);
        this.logger.warn(
          `KPAX ${method} ${path} rate limited; retry #${attempt} in ${Math.round(
            delay,
          )}ms`,
        );
        await this.sleep(delay);
        continue;
      }

      if (
        res.status >= 500 &&
        IDEMPOTENT.has(method) &&
        attempt < this.opts.maxRetries
      ) {
        const delay = this.backoff(attempt++);
        this.logger.warn(
          `KPAX ${method} ${path} HTTP ${
            res.status
          }; retry #${attempt} in ${Math.round(delay)}ms`,
        );
        await this.sleep(delay);
        continue;
      }

      return res;
    }
  }

  /** Overridable for tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private backoff(attempt: number): number {
    const exp = this.opts.baseDelayMs * 2 ** attempt;
    return Math.min(exp / 2 + Math.random() * (exp / 2), this.opts.maxDelayMs);
  }

  private trackRateLimit(h: Record<string, unknown>) {
    const limit = num(header(h, 'x-ratelimit-limit'));
    const remaining = num(header(h, 'x-ratelimit-remaining'));
    const reset = num(header(h, 'x-ratelimit-reset'));
    if (limit === undefined && remaining === undefined && reset === undefined)
      return;
    this.lastRateLimit = { limit, remaining, reset };
    if (remaining === 0 && reset) {
      this.blockedUntil = Math.max(this.blockedUntil, reset * 1000);
    }
  }

  private retryAfterMs(h: Record<string, unknown>): number | undefined {
    const ra = header(h, 'retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return Math.max(secs, 0) * 1000;
      const date = Date.parse(ra);
      if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
    }
    const reset = num(header(h, 'x-ratelimit-reset'));
    if (reset !== undefined) return Math.max(reset * 1000 - Date.now(), 0);
    return undefined;
  }
}

// --------------------------------------------------------------------------

function scopeQuery(scope?: KpaxParentScope) {
  if (!scope) return {};
  return {
    parent_type: scope.parentType,
    parent_id: scope.parentId,
    with_children:
      scope.parentType === 'account' ? scope.withChildren : undefined,
  };
}

function interpolate(path: string, params?: Record<string, unknown>): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') {
      throw new TypeError(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(String(v));
  });
}

function compact(q?: Record<string, unknown>) {
  if (!q) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function header(h: Record<string, unknown>, name: string): string | undefined {
  if (!h) return undefined;
  const get = (h as { get?: (n: string) => unknown }).get;
  const v =
    typeof get === 'function'
      ? get.call(h, name)
      : h[name] ?? h[name.toLowerCase()];
  return v == null ? undefined : String(v);
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
