# Architecture

## Where analysis runs

Everything runs **in the browser**. There is no server: the uploaded file is
read locally, unzipped in memory, parsed, checked and scored client-side, and
never leaves the machine.

That is not just a privacy stance, it is why the app has no backend at all. The
build output is a plain static bundle, so it hosts on GitHub Pages with no
account, no secrets and no runtime cost. Version history is a summary kept in
`localStorage`, which makes it per-browser rather than shared — the price of
having no server. Real multi-user collaboration (assignment, comments across a
team) would need a backend added back, and it could be any host.

## What each Power BI format actually exposes

This is the constraint everything else follows from.

| Format | Model (tables, DAX, relationships, M) | Report (pages, visuals) | Round-trips |
|---|---|---|---|
| `.pbit` | Yes — `DataModelSchema` is TMSL JSON | Yes — `Report/Layout` | Yes |
| `.pbip` | Yes when the project has `model.bim` | Yes — `report.json` | Yes |
| `.pbix` | **No** | Yes — `Report/Layout` | Report layer only |

A `.pbix` stores its model in the `DataModel` part, which is an XPress9-compressed
Analysis Services backup. No JavaScript library can read it; only the Analysis
Services engine can. Verified against a real 24.7 MB file, whose `DataModel`
part begins `This backup was created using XPress9`.

Consequently a `.pbix` upload yields report pages, visuals and every field
binding, and reports the semantic model as explicitly unavailable with the
reason and the remedy. It never guesses, and never renders a placeholder number
in place of a value it could not read.

`Report/Layout` is UTF-16LE JSON in both PBIX and PBIT. The BOM is detected on
read and reproduced on write, because `TextDecoder` strips it by default and a
rewrite that silently dropped it would change the file.

## Module layout

    index.html    Static entry point; no SSR, no server routes.
    src/          App shell and UI.
    lib/powerbi/
      zip.ts      ZIP + UTF-16 I/O and content hashing. All binary handling.
      model.ts    The normalized model. Every consumer depends only on this.
      tmsl.ts     DataModelSchema / model.bim -> tables, measures, relationships.
      layout.ts   Report/Layout -> pages, visuals, field bindings.
      usage.ts    Which pages, visuals and measures reference an object.
      extract.ts  Format detection, capability reporting, entry point.
    lib/qa/
      dax.ts      Comment- and string-aware DAX text analysis.
      rules.ts    The rule catalogue; each rule declares what it needs.
      engine.ts   Runner and scoring.
    lib/history.ts  Version-history summaries in localStorage.

Adding a source format means adding one adapter that produces a `Model`. Nothing
downstream of `model.ts` changes.

## Capabilities, not assumptions

Every extraction reports four capabilities — `model`, `report`, `powerQuery` and
`runtime` — as either available or unavailable **with a reason**. `runtime` is
always unavailable in this build because nothing is executed against the model.
Checks that would need row counts, cardinality or timings are therefore not run
and not scored, rather than being estimated.

The original parsed documents are retained alongside the normalized model in
`RawSources`. Edits will be replayed onto those original documents at export
time, so fields this build does not model still survive the round trip.

## QA scoring

Each finding deducts from its category — critical 15, high 8, medium 3, low 1,
floored at zero. The overall score is the mean of the categories that were
actually assessed.

The important property is what happens when a rule cannot run. Rules declare
their required capabilities, and a rule whose capability is unavailable is
recorded as skipped with the reason. Its category then scores `null`, never 100.
Without that, a PBIX with an unreadable model would score full marks on DAX
quality precisely because no DAX could be read.

Text scans strip comments and string literals before matching, so `-- 50/50`
in a comment does not report an unsafe division. That is checked by test.

## Not yet built

- Optimization analysis and score.
- Object editing, dependency-aware rename, change workspace, diff, validation.
- Export of a modified `.pbit` / `.pbip`.
- TMDL parsing, so PBIP projects that use `definition/*.tmdl` instead of
  `model.bim` are detected and refused with an explanation.
- Culture translations and RLS role DAX are preserved but not analyzed; a rename
  will not update translated captions, and extraction warns when they exist.
- A Windows companion that drives Power BI Desktop's local Analysis Services
  endpoint via TOM would make true `.pbix` read and write possible. It slots in
  as another adapter producing a `Model`; nothing else has to change.

## Product data

Only a version-history summary is persisted, in `localStorage`: file name,
content hash, format, score and finding count. The uploaded file and the
extracted model are never stored, so a long history cannot exhaust the storage
quota. Writes are best-effort; if storage is unavailable the analysis still
completes and the UI says the history was not saved.
