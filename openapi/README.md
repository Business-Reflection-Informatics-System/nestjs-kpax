# KPAX OpenAPI spec (not committed)

The KPAX API v1 spec is KPAX's documentation and is not redistributed here. The Node package
generates `node/src/types/kpax-openapi.generated.ts` from it. After a KPAX upgrade:

1. Log in to your KPAX instance and open `https://<instance>.kpax.cloud/api/docs?api-docs.json`.
2. Save it as `openapi/kpax-openapi.json` (git-ignored).
3. `cd node && npm run generate:types && npm run typecheck && npm test`.
4. Compare new or changed endpoints with the helpers in the other clients; anything else is
   already reachable through each client's generic request method.
