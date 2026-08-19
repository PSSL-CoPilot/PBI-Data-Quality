// Cloudflare runtime globals (Fetcher, D1Database) and the `cloudflare:workers`
// module used by db/index.ts. Referenced this way rather than through tsconfig's
// `types` array, which would suppress the other ambient types the app needs.
/// <reference types="@cloudflare/workers-types" />

/**
 * Bindings this Worker expects. `cloudflare:workers` types its `env` export as
 * `Cloudflare.Env`, an empty interface projects are meant to merge into, so the
 * D1 binding is declared here for `getDb()` in db/index.ts to typecheck.
 *
 * Keep in step with the bindings in `.openai/hosting.json` and vite.config.ts.
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
  }
}
