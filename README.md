# KPAX API clients

Clients for the **KPAX API v1** (printer fleet / managed print services monitoring) in five
languages, maintained by [BizReflex](https://github.com/Business-Reflection-Informatics-System).

| Language | Package | Folder | Highlights |
|---|---|---|---|
| Node / **NestJS** | `@bizreflex/nestjs-kpax` | [`node/`](node) | Nest module, DB-backed registry of KPAX connections that change at runtime, typed `call()` over every endpoint |
| **Python** 3.10+ | `bizreflex-kpax` | [`python/`](python) | `httpx`, thread-safe, typed |
| **Go** 1.23+ | `github.com/Business-Reflection-Informatics-System/nestjs-kpax/go` | [`go/`](go) | stdlib only, `context`, range-over-func iterators |
| **.NET** 8+ | `BizReflex.Kpax` | [`dotnet/`](dotnet) | no dependencies, async, `IAsyncEnumerable` |
| **PHP** 8.1+ | `bizreflex/kpax` | [`php/`](php) | no Composer dependencies, pluggable transport, generators |

> Not affiliated with KPAX. You need your own KPAX instance and an API client
> (client id/secret) from its API panel.

## What every client does

Same behaviour everywhere, defined in the [client behaviour spec](docs/client-behavior.md)
and tested in each language against the shared [fixtures](fixtures):

- OAuth2 **client credentials**; one cached token, refreshed before expiry, shared by
  concurrent callers; one retry with a fresh token on 401.
- **Rate limits**: honours `Retry-After` / `X-RateLimit-Reset`, holds requests when
  `X-RateLimit-Remaining` hits 0.
- **Retries**: 5xx and network errors with exponential backoff for GET/PUT/DELETE; a POST is
  never re-sent after a 5xx or network error.
- **Pagination** helpers, typed models (accounts, devices, alerts, server status), and
  helpers for serial lookup (exact match), fleet-wide attribute search, page volumes,
  history, toner cycles and alert history.
- A generic request method for any endpoint, and a connection test that never throws.

## Install (v0.1.0)

Each `v*` tag publishes all packages as assets on
[GitHub Releases](https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases).

```bash
# Node / NestJS
npm install https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/bizreflex-nestjs-kpax-0.1.0.tgz
# Python
pip install https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/bizreflex_kpax-0.1.0-py3-none-any.whl
# Go
go get github.com/Business-Reflection-Informatics-System/nestjs-kpax/go@v0.1.0
```

.NET (`BizReflex.Kpax.0.1.0.nupkg`) and PHP (`bizreflex-kpax-php-0.1.0.zip`): see
[dotnet/README.md](dotnet/README.md#install) and [php/README.md](php/README.md#install).

## Repository layout

```
docs/          client-behavior.md (the spec), kpax-api-notes.md (auth, scopes, hierarchy, dates)
fixtures/      JSON responses every client's tests serve from a mock KPAX
openapi/       where KPAX's spec goes locally to regenerate Node types (not committed)
node/ python/ go/ dotnet/ php/
.github/       CI per language (path-filtered) and one release workflow
```

## Releasing

1. Set the same version in `node/package.json`, `python/pyproject.toml`,
   `python/src/kpax/__init__.py` and `dotnet/src/BizReflex.Kpax/BizReflex.Kpax.csproj`;
   add a `CHANGELOG.md` entry; merge to `main`.
2. `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z` (or draft a release with a new tag
   in the GitHub UI).
3. The Release workflow checks the versions match the tag, tests every language, attaches the
   Node tarball, Python wheel/sdist, NuGet package and PHP zip to the release, and tags the Go
   module as `go/vX.Y.Z`.

## License

[MIT](LICENSE) © 2026 BizReflex LLC-FZ
