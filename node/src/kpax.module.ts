import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { KpaxConfigurableModuleClass } from './kpax.module-definition';
import { KpaxTokenService } from './auth/kpax-token.service';
import { KpaxClientFactory } from './client/kpax-client.factory';
import { KpaxConnectionRegistry } from './registry/kpax-connection.registry';
import { KPAX_CONNECTION_STORE } from './kpax.constants';

/**
 * KPAX API v1 for NestJS.
 *
 *   KpaxModule.forRootAsync({
 *     isGlobal: true,
 *     imports: [KpaxConnectionsDataModule],     // whatever the store depends on
 *     connectionStore: AppKpaxConnectionStore,   // implements KpaxConnectionStore
 *     useFactory: () => ({ registry: { syncIntervalMs: 60_000 } }),
 *   })
 *
 * Inject KpaxConnectionRegistry and call `await registry.get(connectionId)`.
 * See README.md and docs/ for the full guide.
 */
@Module({
  imports: [HttpModule],
  providers: [KpaxTokenService, KpaxClientFactory, KpaxConnectionRegistry],
  exports: [KpaxClientFactory, KpaxConnectionRegistry, KPAX_CONNECTION_STORE],
})
export class KpaxModule extends KpaxConfigurableModuleClass {}
