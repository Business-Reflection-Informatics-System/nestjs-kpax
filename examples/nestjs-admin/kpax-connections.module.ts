import { Module } from '@nestjs/common';
import { KpaxModule } from '@bizreflex/nestjs-kpax';
import { KpaxConnectionDbStore } from './kpax-connection.store';
import { SecretCipher } from './secret-cipher';
import { KpaxConnectionsController } from './kpax-connections.controller';

/** Gives the store its cipher. */
@Module({
  providers: [SecretCipher],
  exports: [SecretCipher],
})
export class KpaxCryptoModule {}

/**
 * KPAX for the whole app + admin endpoints.
 *
 * Requires a global provider for the KNEX token (your knex instance), e.g. from
 * a @Global() DatabaseModule. Set KPAX_SECRET_KEY for secret encryption.
 */
@Module({
  imports: [
    KpaxModule.forRootAsync({
      isGlobal: true,
      imports: [KpaxCryptoModule],
      connectionStore: KpaxConnectionDbStore,
      useFactory: () => ({
        registry: {
          syncIntervalMs: Number(process.env.KPAX_SYNC_INTERVAL_MS ?? 60_000),
        },
      }),
    }),
  ],
  controllers: [KpaxConnectionsController],
})
export class KpaxConnectionsModule {}
