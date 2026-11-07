import { Inject, Injectable } from '@nestjs/common';
import { KnexKpaxConnectionStore } from '@bizreflex/nestjs-kpax';
import { SecretCipher } from './secret-cipher';

/** DI token for your app's knex instance (provide it however your app does). */
export const KNEX = Symbol('KNEX');

/** kpax_connections over knex, secrets encrypted with SecretCipher. */
@Injectable()
export class KpaxConnectionDbStore extends KnexKpaxConnectionStore {
  constructor(@Inject(KNEX) knex: unknown, cipher: SecretCipher) {
    super({
      knex: () => knex,
      encrypt: (plain) => cipher.encrypt(plain),
      decrypt: (payload) => cipher.decrypt(payload),
    });
  }
}
