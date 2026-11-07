# Development

## Layout

```
src/
  kpax.module.ts                 KpaxModule (ConfigurableModuleBuilder: forRoot / forRootAsync)
  kpax.module-definition.ts      options token, extras (isGlobal, connectionStore)
  registry/                      KpaxConnectionRegistry
  client/                        KpaxClient, KpaxClientFactory, pagination, connection utils
  auth/                          KpaxTokenService (OAuth2 client credentials)
  stores/                        KnexKpaxConnectionStore
  interfaces/ errors/ types/     public contracts; types/kpax-openapi.generated.ts is generated
examples/
  knex-migration/                kpax_connections table
  nestjs-admin/                  store, cipher, admin controller, module (tested)
openapi/                         where the KPAX spec goes locally (git-ignored)
scripts/generate-types.js        regenerates the types from the spec
test/                            jest specs (mock KPAX over axios, in-memory + SQLite stores)
.github/workflows/               CI and release
```

## Commands

```bash
npm install
npm run typecheck            # strict TS over src, test and examples
npm test                     # jest (unit + example e2e)
npm run lint
npm run build                # dist/ (CommonJS + .d.ts)
npm pack                     # bizreflex-nestjs-kpax-<version>.tgz
```

Tests cover auth, retries, rate limits, pagination, device helpers, connection tests,
registry boot/sync/reload/lazy-load/failure handling, the knex store against SQLite using
the example migration, and the example admin module over HTTP. CI runs them on Node 18, 20
and 22, and on NestJS 9 and 10.

## Regenerating types after a KPAX upgrade

KPAX's spec is not redistributed in this repo (see [`openapi/README.md`](../../openapi/README.md)).

1. Log in to a KPAX instance, open `https://<instance>.kpax.cloud/api/docs?api-docs.json`,
   save it as `openapi/kpax-openapi.json` at the repo root (git-ignored).
2. `npm run generate:types && npm run typecheck && npm test`.
3. The generator strips descriptions and examples, so the committed file is type structure
   only. Compile errors point at helpers whose endpoints changed.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`; merge to `main`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow checks the tag matches `package.json`, runs the full test suite,
   builds, packs, and creates a GitHub Release with `bizreflex-nestjs-kpax-<version>.tgz`
   attached.
4. Consumers update the URL in their `package.json`:
   ```
   https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.2.0/bizreflex-nestjs-kpax-0.2.0.tgz
   ```

Semver: breaking = removed/renamed exports, changed method signatures, changed store
contract, changed default scopes or migration columns.

`"private": true` in `package.json` stops an accidental `npm publish`. Remove it if you
decide to publish to the npm registry as well.

## Trying local changes in an app

Don't `npm install ../nestjs-kpax`: the symlinked package resolves its own copy of
`@nestjs/common`, and Nest dependency injection fails across the two copies. Instead:

```bash
npm run build && npm pack
cd ../your-app && npm install ../nestjs-kpax/bizreflex-nestjs-kpax-0.1.0.tgz
```
