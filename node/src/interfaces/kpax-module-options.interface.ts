/**
 * Static, non-secret behaviour of the KPAX module. Connection details (URL,
 * client id/secret) are NOT configured here: they come from the
 * KpaxConnectionStore (your database) or are passed per call.
 */
export interface KpaxModuleOptions {
  /** Scopes requested when a connection doesn't specify its own. Default KPAX_DEFAULT_READ_SCOPES. */
  defaultScopes?: string[];
  /** Per-attempt HTTP timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Max retries for 429 / 5xx / network errors. Default 4. */
  maxRetries?: number;
  /** Base backoff in ms for 5xx / network errors (exponential + jitter). Default 500. */
  baseDelayMs?: number;
  /** Cap on any single wait, including Retry-After. Default 60_000. */
  maxDelayMs?: number;
  /** Refresh the access token this many seconds before it expires. Default 60. */
  tokenRefreshSkewSeconds?: number;
  /** Max ad-hoc connections (factory.forConnection) kept in memory. Default 50. */
  maxCachedConnections?: number;
  /** Connection registry behaviour (only used when a connectionStore is registered). */
  registry?: KpaxRegistryOptions;
}

export interface KpaxRegistryOptions {
  /** Load every active connection when the application boots. Default true. */
  loadOnBoot?: boolean;
  /**
   * Re-check the store this often (ms) to pick up changes made by other
   * processes/pods. 0 disables. Default 60_000.
   */
  syncIntervalMs?: number;
  /**
   * Abort application start-up if the initial load fails (DB down, table
   * missing). Default false: log it and retry on the next sync.
   */
  failOnBootError?: boolean;
  /**
   * On get(id) for an id that isn't registered, ask the store once before
   * failing. Lets a connection created in another pod be used immediately.
   * Default true.
   */
  loadOnMiss?: boolean;
}

export const KPAX_DEFAULT_READ_SCOPES = [
  'accounts:read',
  'agents:read',
  'devices:read',
  'hierarchy-elements:read',
  'dynamic-groups:read',
  'profiles:read',
  'rules:read',
  'labels:read',
  'server:read',
];

export interface ResolvedKpaxModuleOptions
  extends Required<Omit<KpaxModuleOptions, 'registry'>> {
  registry: Required<KpaxRegistryOptions>;
}

export function resolveKpaxOptions(
  opts: KpaxModuleOptions = {},
): ResolvedKpaxModuleOptions {
  const o = opts ?? {};
  const r = o.registry ?? {};
  return {
    defaultScopes: o.defaultScopes?.length
      ? o.defaultScopes
      : KPAX_DEFAULT_READ_SCOPES,
    timeoutMs: o.timeoutMs ?? 30_000,
    maxRetries: o.maxRetries ?? 4,
    baseDelayMs: o.baseDelayMs ?? 500,
    maxDelayMs: o.maxDelayMs ?? 60_000,
    tokenRefreshSkewSeconds: o.tokenRefreshSkewSeconds ?? 60,
    maxCachedConnections: o.maxCachedConnections ?? 50,
    registry: {
      loadOnBoot: r.loadOnBoot ?? true,
      syncIntervalMs: r.syncIntervalMs ?? 60_000,
      failOnBootError: r.failOnBootError ?? false,
      loadOnMiss: r.loadOnMiss ?? true,
    },
  };
}
