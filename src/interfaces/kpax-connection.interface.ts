/** What is needed to talk to one KPAX instance. */
export interface KpaxConnection {
  /** Instance base URL, e.g. https://acme.kpax.cloud (no /api/v1 suffix). */
  host: string;
  /** OAuth2 client id from the KPAX API panel. */
  clientId: string;
  /** OAuth2 client secret from the KPAX API panel (plaintext, already decrypted). */
  clientSecret: string;
  /** Scopes to request. Falls back to the module's defaultScopes. */
  scopes?: string[];
}

/** Identifier of a stored connection (a DB primary key, usually). */
export type KpaxConnectionId = string | number;

/** A connection as stored by the application (one row of `kpax_connections`). */
export interface KpaxConnectionRecord extends KpaxConnection {
  id: KpaxConnectionId;
  /** Human label shown in the admin section, e.g. "Head office". */
  name: string;
  isActive: boolean;
  /**
   * Changes whenever the row changes (epoch millis of the last write is fine).
   * The registry uses it to notice edits made by other processes.
   */
  updatedAt: number;
}

/** Version marker for cheap change detection. */
export interface KpaxConnectionVersion {
  id: KpaxConnectionId;
  updatedAt: number;
}

/**
 * Where the application keeps its KPAX connections. Implement it against your
 * database (or extend KnexKpaxConnectionStore) and register it with
 * KpaxModule.forRoot/forRootAsync({ connectionStore }).
 */
export interface KpaxConnectionStore {
  /** Every ACTIVE connection, secrets decrypted. Called on boot and when a full sync is needed. */
  findActive(): Promise<KpaxConnectionRecord[]>;
  /** One connection by id, active or not, secret decrypted. Null when it doesn't exist. */
  findById(id: KpaxConnectionId): Promise<KpaxConnectionRecord | null>;
  /**
   * Optional: ids + versions of every ACTIVE connection, without secrets.
   * When present, periodic sync uses it and only re-reads rows that changed,
   * instead of loading and decrypting every row each interval.
   */
  findActiveVersions?(): Promise<KpaxConnectionVersion[]>;
}

/** Public, secret-free view of a registered connection. */
export interface KpaxConnectionSummary {
  id: KpaxConnectionId;
  name: string;
  host: string;
  clientId: string;
  scopes?: string[];
  updatedAt: number;
}
