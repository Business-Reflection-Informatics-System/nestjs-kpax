import { ConfigurableModuleBuilder, Provider, Type } from '@nestjs/common';
import { KpaxModuleOptions } from './interfaces/kpax-module-options.interface';
import { KpaxConnectionStore } from './interfaces/kpax-connection.interface';
import { KPAX_CONNECTION_STORE } from './kpax.constants';

export interface KpaxModuleExtras {
  /** Register the module globally. Default false. */
  isGlobal?: boolean;
  /**
   * Class implementing KpaxConnectionStore (e.g. extending
   * KnexKpaxConnectionStore). Its dependencies must be resolvable here: pass
   * the modules that provide them via forRootAsync({ imports }), or use global
   * providers. Without a store the registry stays empty and you use
   * KpaxClientFactory.forConnection() directly.
   */
  connectionStore?: Type<KpaxConnectionStore>;
}

export const {
  ConfigurableModuleClass: KpaxConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: KPAX_MODULE_OPTIONS,
  OPTIONS_TYPE: KPAX_OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE: KPAX_ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<KpaxModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras<KpaxModuleExtras>(
    { isGlobal: false, connectionStore: undefined },
    (definition, extras) => {
      const storeProvider: Provider = extras.connectionStore
        ? { provide: KPAX_CONNECTION_STORE, useClass: extras.connectionStore }
        : { provide: KPAX_CONNECTION_STORE, useValue: null };
      return {
        ...definition,
        global: extras.isGlobal,
        providers: [...(definition.providers ?? []), storeProvider],
      };
    },
  )
  .build();

export type KpaxModuleOptionsInput = typeof KPAX_OPTIONS_TYPE;
export type KpaxModuleAsyncOptionsInput = typeof KPAX_ASYNC_OPTIONS_TYPE;
