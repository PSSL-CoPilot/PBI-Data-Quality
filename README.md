# PBI Quality Studio

Power BI model quality, DAX review, report usage, dependency analysis and
collaborative issue management.

## Run locally

1. Install Node.js 22+ and run `npm install`.
2. Run `npm run dev` and open the displayed URL.

## What works today

Upload a Power BI file and it is parsed **in your browser** — the file is never
uploaded. You get real tables, columns, measures with their DAX, relationships,
Power Query/M and native SQL partitions, report pages, visuals, and which
pages, visuals and measures reference a given measure.

Which of those you get depends on the format:

- **`.pbit` / `.pbip`** — full semantic model and report.
- **`.pbix`** — report layer only. A `.pbix` keeps its model in a binary
  Analysis Services part that only Power BI Desktop can open, so the model is
  reported as unavailable with the reason. To analyze the model, export from
  Power BI Desktop with **File → Export → Power BI template**.

Nothing on screen is sample data. Where a value could not be read, the UI shows
why instead of a number.

### Automated QA and the quality score

23 rules across DAX, Model, Relationship, Report and Data quality produce a
score per category plus an overall score, with critical/high/medium/low counts
and a priority queue. Every finding names the object it is about and clicking it
opens that measure, table, relationship or page.

A rule that cannot run is reported as **skipped with a reason**, and its
category scores nothing rather than defaulting to a pass — so a report-only
PBIX shows "—" for DAX, not 100. Checks that would need a live query engine
(row counts, cardinality, render timings) are listed as out of scope rather
than silently omitted.

## Fonts

The UI is set in **Gotham**, which is a licensed Hoefler&Co typeface and is not
redistributed in this repository. The stack resolves in this order:

1. Gotham installed on the machine (picked up via `local()`).
2. Gotham webfonts you supply at `public/fonts/Gotham-Book.woff2`,
   `Gotham-Medium.woff2` and `Gotham-Bold.woff2` — drop them in, no code change.
3. Montserrat, the closest freely available geometric sans.

## Not built yet

Optimization analysis and score, object editing, dependency-aware renames,
change tracking, validation and export. Those views say so rather than showing
placeholder content. See `docs/ARCHITECTURE.md`.

## Deploying

The app is a Cloudflare Worker (SSR + one API route) with a D1 database.
`.github/workflows/deploy.yml` lints, typechecks, tests and builds on every push
to `main`, applies pending D1 migrations, then deploys.

It needs four one-time setup steps:

1. Create the D1 database:
   `npx wrangler d1 create pbi-quality-studio` — note the returned `database_id`.
2. Create a Cloudflare API token with **Workers Scripts: Edit**, **D1: Edit** and
   **Workers R2/KV** not required.
3. Add repository secrets under Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_D1_DATABASE_ID` (from step 1)
4. Optionally add the repository variable `CLOUDFLARE_D1_DATABASE_NAME`
   (defaults to `pbi-quality-studio`).

Without `CLOUDFLARE_D1_DATABASE_ID` the build falls back to a placeholder id
that is fine for local Miniflare but binds to nothing in production, so version
history would fail while analysis kept working.

To deploy by hand:

```
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

## Repository map

- `app/`: QA workspace UI and the version-history API route
- `lib/powerbi/`: extraction, normalized model, usage analysis
- `db/`: collaboration and version schema
- `docs/ARCHITECTURE.md`: formats, capabilities and design
- `tests/`: extraction and product-surface checks (`npm test`)

Never commit environment files or corporate PBIX files.
