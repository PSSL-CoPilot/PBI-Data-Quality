import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

// Miniflare only needs a well-formed id to spin up a local database, but a real
// deploy must use the actual one. Binding a production Worker to an id that does
// not exist in the account fails the deploy outright, so a build with no id
// supplied omits the binding entirely instead.
const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const realDatabaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const d1DatabaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME || "site-creator-d1";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

/**
 * `serve` is local dev, where the placeholder id is fine because Miniflare
 * creates the database locally. `build` is headed for a real account, so the
 * binding is only emitted when a real id was supplied. Without a database the
 * app still works: analysis is client-side and only version history is lost.
 */
const bindingConfig = (command: "serve" | "build") => ({
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases:
    d1 && (realDatabaseId || command === "serve")
      ? [
          {
            binding: d1,
            database_name: d1DatabaseName,
            database_id: realDatabaseId || PLACEHOLDER_DATABASE_ID,
            // Lets `wrangler d1 migrations apply` track what has already run.
            migrations_dir: "drizzle",
          },
        ]
      : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
});

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: bindingConfig(command),
      }),
    ],
  };
});
