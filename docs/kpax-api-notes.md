# KPAX API notes

Facts about KPAX API v1 (as of KPAX 3.20) that shape
how this library works.

## Endpoints and auth

| | |
|---|---|
| API base | `https://<instance>.kpax.cloud/api/v1` |
| Token | `POST https://<instance>.kpax.cloud/oauth/token` |
| Grant | OAuth2 **client credentials** (`grant_type=client_credentials`, form-encoded) |
| Credentials | `client_id` / `client_secret` from the **KPAX API panel**, or from the KPAX team |

The *access token* that can be generated in KPAX **Settings** is not what the API's OAuth
flow expects; use an API client id/secret. (For a quick manual test, a Settings token can be
sent as a Bearer token, but it cannot be refreshed.)

## Scopes

Requested with the token, space-separated. **If the token lacks a scope an endpoint needs,
KPAX returns 401, not 403.**

Default (read-only) set used by this library:

```
accounts:read agents:read devices:read hierarchy-elements:read dynamic-groups:read
profiles:read rules:read labels:read server:read
```

Write scopes exist for accounts, agents, devices, dynamic groups, labels and custom fields
(`devices:update`, `labels:assign`, `devices:custom-fields:update`, …). Add them per connection
only where needed.

> Spec quirk: some operations list scopes as `accounts-read` in their `security` block,
> while the OAuth flow defines `accounts:read`. The colon form is used. If a connection gets
> 401 on *every* call with correct credentials, this is the first thing to check.

## Hierarchy

- Each API client is bound to a hierarchy level (an account).
- To query below it, pass `parent_type` + `parent_id` (`scope` in this library). Both or neither.
- `parent_type`: `account`, or `dynamic_group` on device endpoints (needs `dynamic-groups:read` too).
- `GET /hierarchy-elements` returns the tree (accounts, agents, devices, dynamic groups).
- 403 means the resource is outside the client's level.

## Data conventions

- All dates are **UTC**.
- Pagination is Laravel-style: `{ data, meta: { current_page, last_page, per_page, total }, links }`.
- `per_page` (1–1000) is only honoured with `schema=core`. `schema=full` returns full device objects.
- Devices have an *effective* `serial_number` (may be overridden in KPAX) and the device-reported
  `serial_number_origin`; the same for manufacturer and model.
- `POST /devices/search` is `application/x-www-form-urlencoded`; `attributes` and `filters` are
  JSON strings inside the form. Only `last_check` and `serial_number` are filterable.
- `GET /devices/search-by-serial-number` needs at least 5 characters and is a partial match.

## Spec quirks

- Several parameters are declared `"type": "enum"` (not valid OpenAPI). The generator still
  produces the right union types.
- Some operation ids are hashes (`de89deace913…` for supply cycles); use paths, not operation ids.

## Updating the spec

See [development.md](development.md#regenerating-types-after-a-kpax-upgrade). The spec itself is
not redistributed here.
