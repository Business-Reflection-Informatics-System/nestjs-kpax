/**
 * KPAX instances registered at runtime (e.g. from an admin screen). Used by
 * KnexKpaxConnectionStore from @bizreflex/nestjs-kpax.
 *
 * - client_secret_encrypted: encrypt before writing (the store's `encrypt`
 *   hook); never store or return the secret in plaintext.
 * - scopes: space-separated OAuth scopes; NULL means the module defaults.
 * - updated_at: epoch millis, bumped on every write. Other processes compare
 *   it to notice changes, so every write MUST set it.
 * - Rows are soft-deleted (deleted_at) so anything that references a
 *   connection id keeps resolving.
 *
 * Works on PostgreSQL and SQLite. Rename the file to your migration naming scheme.
 */
const tableName = 'kpax_connections';

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable(tableName);
  if (!exists) {
    await knex.schema.createTable(tableName, function (table) {
      table.bigIncrements('id').primary();
      table.string('name', 100).notNullable();
      table.string('host', 255).notNullable();
      table.string('client_id', 255).notNullable();
      table.text('client_secret_encrypted').notNullable();
      table.text('scopes').nullable();
      table.boolean('is_active').notNullable().defaultTo(true);
      table.bigInteger('created_by');
      table.bigInteger('created_at');
      table.bigInteger('updated_by');
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('deleted_at');
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS kpax_connections_name_uq
      ON ${tableName} (lower(name)) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS kpax_connections_active_idx
      ON ${tableName} (is_active) WHERE deleted_at IS NULL
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists(tableName);
};
