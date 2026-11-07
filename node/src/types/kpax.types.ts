import type { components, paths } from './kpax-openapi.generated';

export type { components, paths, operations } from './kpax-openapi.generated';

type Schemas = components['schemas'];
export type KpaxAccount = Schemas['Account'];
export type KpaxDeviceCore = Schemas['DeviceCore'];
export type KpaxDeviceFull = Schemas['DeviceFull'];
export type KpaxDevice = KpaxDeviceCore | KpaxDeviceFull;
export type KpaxDeviceSearchResult = Schemas['DeviceSearch'];
export type KpaxDeviceVolumes = Schemas['DeviceVolumes'];
export type KpaxDeviceDailySnapshot = Schemas['DeviceDailySnapshot'];
export type KpaxDeviceSupplyCycle = Schemas['DeviceSupplyCycle'];
export type KpaxAlertHistoryEvent = Schemas['AlertHistoryEvent'];
export type KpaxAttributeValue = Schemas['AttributeValue'];
export type KpaxProfile = Schemas['Profile'];
export type KpaxPaginationMeta = Schemas['PaginationMeta'];
export type KpaxPaginationLinks = Schemas['PaginationLinks'];

export interface KpaxPage<T> {
  data: T[];
  meta?: KpaxPaginationMeta;
  links?: KpaxPaginationLinks;
}

export type KpaxParentType = 'account' | 'dynamic_group';

/** Scope a listing to a hierarchy container (account or dynamic group). */
export interface KpaxParentScope {
  parentType: KpaxParentType;
  parentId: number;
  /** Include sub-accounts. KPAX ignores it for dynamic groups. */
  withChildren?: boolean;
}

export interface KpaxAttributeRef {
  namespace: string;
  name: string;
}

export interface KpaxSearchFilter {
  namespace: 'kpax.core.print.devices';
  /** Only these two attributes are filterable. */
  name: 'last_check' | 'serial_number';
  /** last_check: greater_or_equal | less_or_equal | greater | less | equal. serial_number: equal | contains. */
  operator:
    | 'greater_or_equal'
    | 'less_or_equal'
    | 'greater'
    | 'less'
    | 'equal'
    | 'contains';
  /** For last_check, "YYYY-MM-DD HH:mm:ss" in UTC. */
  value: string;
}

export type KpaxDeviceSort =
  | 'manufacturer'
  | '-manufacturer'
  | 'model'
  | '-model'
  | 'created_at'
  | '-created_at';
export type KpaxVolumeInterval =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';
export type KpaxCartridge = 'black' | 'cyan' | 'yellow' | 'magenta';
export type KpaxDeviceAttributeFilter =
  | 'general'
  | 'meters'
  | 'supplies'
  | 'parts'
  | 'alerts'
  | 'volumes'
  | 'label_printer'
  | 'custom_fields'
  | 'editable'
  | 'settings';

// ---------------------------------------------------------------------------
// Typed access to every operation in the spec (KpaxClient.call)
// ---------------------------------------------------------------------------

export type KpaxHttpMethod = 'get' | 'post' | 'put' | 'delete';

/** Operation object for a path + method, or never if the spec doesn't define it. */
export type KpaxOperation<
  P extends keyof paths,
  M extends KpaxHttpMethod,
> = NonNullable<paths[P][M]>;

/** Paths that support the given method. */
export type KpaxPathsFor<M extends KpaxHttpMethod> = {
  [P in keyof paths]: [KpaxOperation<P, M>] extends [never] ? never : P;
}[keyof paths];

type ParamsOf<O> = O extends { parameters: infer X } ? X : never;

export interface KpaxCallOptions<O> {
  path?: ParamsOf<O> extends { path: infer A } ? A : never;
  query?: ParamsOf<O> extends { query?: infer Q } ? Q : never;
  body?: O extends {
    requestBody?: { content: { 'application/json': infer B } };
  }
    ? B
    : never;
  /** For form-encoded endpoints (POST /devices/search). */
  form?: Record<string, string>;
}

type JsonOf<R> = R extends { content: { 'application/json': infer J } }
  ? J
  : void;

export type KpaxResponseOf<O> = O extends { responses: infer Rs }
  ? 200 extends keyof Rs
    ? JsonOf<Rs[200]>
    : 201 extends keyof Rs
      ? JsonOf<Rs[201]>
      : void
  : unknown;
