/**
 * Non-2xx response from KPAX that survived the retry policy.
 *
 * KPAX semantics: 400 bad params; 401 bad token OR missing scope; 403 resource
 * outside the client's hierarchy; 404 not found; 409 delete refused; 429 rate limited.
 *
 * Deliberately not an HttpException: an upstream 401/403 must not leak out as
 * our own API's status code. Map it at the controller boundary.
 */
export class KpaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: unknown,
    message?: string,
  ) {
    super(
      message ??
        `KPAX ${method} ${url} failed with HTTP ${status}${describe(body)}`,
    );
    this.name = 'KpaxApiError';
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

/** The /oauth/token endpoint rejected the client credentials. */
export class KpaxAuthError extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
    readonly body: unknown,
  ) {
    super(
      `KPAX token request to ${host} failed with HTTP ${status}${describe(
        body,
      )}`,
    );
    this.name = 'KpaxAuthError';
  }
}

/** No usable connection: no store registered, invalid URL, or missing credentials. */
export class KpaxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KpaxConfigurationError';
  }
}

/** The registry has no active connection with this id. */
export class KpaxConnectionNotFoundError extends KpaxConfigurationError {
  constructor(readonly connectionId: string | number) {
    super(`KPAX connection "${connectionId}" is not registered or not active`);
    this.name = 'KpaxConnectionNotFoundError';
  }
}

function describe(body: unknown): string {
  if (body == null || body === '') return '';
  if (typeof body === 'string') return `: ${body.slice(0, 300)}`;
  if (typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error_description ?? b.error;
    if (typeof msg === 'string') return `: ${msg}`;
    try {
      return `: ${JSON.stringify(body).slice(0, 300)}`;
    } catch {
      return '';
    }
  }
  return '';
}
