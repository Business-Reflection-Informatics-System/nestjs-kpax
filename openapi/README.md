# KPAX OpenAPI spec (not committed)

The KPAX API v1 spec is KPAX's documentation and is not redistributed here. To regenerate
`src/types/kpax-openapi.generated.ts` after a KPAX upgrade:

1. Log in to your KPAX instance and open `https://<instance>.kpax.cloud/api/docs?api-docs.json`.
2. Save it as `openapi/kpax-openapi.json` (git-ignored).
3. `npm run generate:types && npm run typecheck && npm test`.
