# Martin Open Data

A civic data dashboard for the city of Martin, Slovakia, built entirely on data that is already public. No agreements, no API keys, no third parties.

The city publishes 16 datasets through its CG eGOV portal, but only as paginated tables behind an ASP.NET portal. This project turns them into a queryable database and a dashboard, and adds five more feeds the city, SHMU, ŠÚ SR and ÚPSVaR already serve.

## What it shows

- EUR 359 million of municipal spending across 247 748 documents since 2011
- 5 129 suppliers, after collapsing spelling variants of the same name
- Per-supplier drill-down with IČO resolved from the national business register
- Full-text search across invoice and order subjects, diacritic-insensitive
- Air quality and river levels for Martin, as self-accumulated time series
- Demography: population by street, an age pyramid, registered unemployment
- Paid parking zones drawn over the city's seven districts
- The city's official notice board

## Data sources

All endpoints are public and unauthenticated.

| Dataset | Scale | Endpoint |
| --- | --- | --- |
| Supplier invoices | 157 306 rows | `egov.martin.sk` … `779:0::plac1929:_144102_5_8` |
| Purchase orders | 91 101 rows | `egov.martin.sk` … `781:0::plac1931:_144104_5_8` |
| Contracts | 30 384 rows | `egov.martin.sk` … `778:0::plac1889:_144101_5_8` |
| Population per street | 266 rows | `egov.martin.sk` … `900:0::plac520:_144017_5_8` |
| Population per year of age | 107 rows | `egov.martin.sk` … `920:0::plac1140:_144053_5_8` |
| Air quality | hourly | `shmu.sk/api/v1/airquality/getdata?station=99271` |
| River levels | 15-minute | `shmu.sk/sk/?page=1&id=hydro_vod_za&station_id=6130` |
| Registered unemployment | monthly | `upsvr.gov.sk/statistiky/open-data/UoZ-01-zakladne-ukazovatele.json` |
| Business register (IČO) | on demand | `api.statistics.sk/rpo/v1/search?fullName=…` |
| City financial statements | 13 years | `registeruz.sk/cruz-public/api/…` (entity 23450) |
| Public procurement | 223 tenders | `uvo.gov.sk/vyhladavanie/vyhladavanie-zakaziek?obstarIco=00316792` |
| National statistics | 877 values | `data.statistics.sk/api/v2/dataset/{cube}/{territory}/…` |
| Municipal election 2022 | 124 candidates | `volby.statistics.sk/oso/oso2022/files/OSO2022_SK_csv.zip` |
| Parking zones | 17 polygons | `datamesta.martin.sk/server/api/parking/map/parkZone` |
| City districts | 7 polygons | `martin.gisplan.sk/services/mapserver/local/hranice/gservice` (WFS) |
| Street lighting | 11 884 features | `martin.gisplan.sk/…/common/paosv/gservice` (WFS) |
| Mowing | 9 651 features | `martin.gisplan.sk/…/local/pzpom/gservice` (WFS) |
| Civil protection | 132 features | `martin.gisplan.sk/…/local/civo/gservice` (WFS) |
| Greenery | 32 441 features | `martin.gisplan.sk/…/common/pazel/gservice` (WFS) |
| City-owned parcels | 3 418 polygons | `martin.gisplan.sk/…/common/majetok/gservice` (WFS) |
| Schools | 53 points | `martin.gisplan.sk/…/local/skoly/gservice` (WFS) |
| Notice board | 50 items | `martin.sk/rss/` |

On the eGOV URLs the trailing `_5_8` selects JSON. Each one 302-redirects to `/OutputStreamHttpHandler.ashx` with a short-lived `cacheKey`, so redirects must be followed and the URLs are not stable permalinks.

The SHMU, RPO and datamesta endpoints are undocumented. Station 99271 is `Martin, Jesenského`; gauges 6130 and 6140 are the Turiec and Pivovarský potok.

## Architecture

```
GitHub Actions
  ├─ etl.yml   (daily)      spending snapshots, city facts, geometry, IČO ─┐
  └─ live.yml  (every 6 h)  air quality, river levels, unemployment, RSS  ─┤
                                                                           ↓
                                                                   Postgres (Neon)
                                                                           ↓
                                                                  Next.js on Vercel
```

The ETL does not run on Vercel. Generating the orders export takes about 40 seconds server-side before a byte is streamed, and the payload is 80 MB — well past the 60-second Vercel Hobby function limit. Vercel Hobby also caps cron at once per day, which the air quality feed cannot live with. GitHub Actions has a 6-hour budget, no cron cap, and costs nothing for a public repository.

**Two schedules, because the sources have opposite shapes.** The spending exports, the population tables and the geometry are full snapshots, so a daily wholesale replace is both sufficient and correct. SHMU air quality, by contrast, serves a rolling **24-hour** window and the river gauges about ten days; ÚPSVaR republishes only the current month. A once-a-day job would leave the air feed with zero overlap, so a single missed run would punch a permanent hole in the history. Running every six hours tolerates three consecutive failures.

**A failed source costs only itself.** The live job stores each source in its own transaction, as the daily job already did for its register sources. Either job records a run with such an isolated failure as `partial` in `etl_runs` and still exits non-zero, so the Actions run goes red. ÚVO is the one exception: from GitHub-hosted runners it fails on most days (see Procurement below), so its failure is an Actions warning on a green run. The live job used to load everything in one transaction, and between 15 and 24 September 2026 an unreachable martin.sk RSS feed or a single `"PDL"` text marker in SHMU's numeric `value` field discarded every source on each run — 75 hours of air readings are permanently missing as a result.

## What the data actually looks like

Findings from profiling the sources, not assumptions. These shaped the schema.

**The spending data has no natural primary key.** Document numbers are reused: 157 306 invoices carry only 120 856 distinct numbers, and 91 101 orders carry 21 741. Order number `2016038` alone appears 12 times across unrelated suppliers and dates. Those tables are replaced wholesale inside one transaction rather than upserted on a source key.

Air readings, river levels, unemployment and notices are the opposite case — they have genuine keys, so they accumulate by upsert and are never truncated. Their history exists only because this pipeline keeps collecting it.

**A Postgres `date` is not an instant.** node-postgres parses `date` into a JS Date at local midnight; a later `.toISOString()` converts that back to UTC and, at Europe/Bratislava's offset, silently moves the calendar day back by one. An invoice issued 2026-09-01 rendered as 2026-08-31 across the whole site. `lib/pg-date.ts` disables that parser so dates stay plain `YYYY-MM-DD` strings. Timestamps are unaffected.

**There is no company identifier in the source.** A supplier is free text with no IČO. The national RPO register closes most of that gap, but carefully — see below.

**Supplier names are cleaner than expected.** Of 5 062 distinct raw spellings, only 96 collide after normalisation (lowercase, strip diacritics, strip legal form, strip punctuation), covering about 3.8%. Deterministic normalisation is enough. `Brantner Fatra s.r.o.` and `BRANTNER Slovakia s.r.o.` stay separate, which is correct — they are different legal entities.

**Amounts and dates are consistently formatted.** Amounts arrive as strings with a space thousands separator and comma decimal (`"  1 919,76"`). Dates are `DD.MM.YYYY` without exception. Currency is effectively always EUR — exactly two SKK rows exist in the entire corpus, and both are dropped.

**The RSS feed publishes naive local timestamps.** `Fri, 11 Sep 2026 12:26` carries no timezone, so `new Date()` would silently adopt the runner's zone. The naive value is kept and converted by Postgres with `set local time zone 'Europe/Bratislava'`, which also gets DST right.

**Usable history starts in 2011.** Earlier years exist but hold single-digit record counts.

## Resolving suppliers to IČO

RPO returns a single, confident-looking result for the wrong company often enough that hit count cannot be the test: searching `Turvod` returns exactly one match, `TURVOD-MH, s.r.o.`, while Martin's actual water utility is `Turčianska vodárenská spoločnosť`. So a hit is accepted only when one of the entity's names — current **or historical** — normalises to the same key as ours. Everything else is stored as unmatched, deliberately.

Historical names are the real prize: RPO knows `EKOPOLIS spol. s r.o.` (1993–2005) became `Brantner Fatra s.r.o.`, and `Martico, a.s.` became `STEFE Martin, a.s.` The invoice data cannot see that at all.

One non-obvious mechanic: RPO's `fullName` search returns **zero** hits when the query carries the legal form — `Brantner Fatra s.r.o.` finds nothing, `Brantner Fatra` finds it. The form is therefore stripped for the query only; the acceptance test still compares full normalised names, so the looser query cannot loosen the match. `BM-MONT` shows why that matters: it returns three entities, including a sole trader and an unrelated company, and only one of them normalises to ours.

Two practical constraints shape the job. RPO answers in 2–5 seconds, and it offers no way to select Slovak entities by municipality, so lookups are one name at a time. Only suppliers invoiced at least EUR 10 000 in total are attempted — 991 of them, between them 97.9% of all the money. Results, including misses, are cached in `supplier_ico`, which is keyed by the stable `norm_key` and survives the daily snapshot reload, so the work converges to nothing after a few runs.

Records from the trade licence register (sole traders, i.e. natural persons) are skipped.

## Search

Postgres ships no Slovak stemming dictionary, so search runs on the `simple` configuration over an `unaccent`-ed vector, with a prefix match on every term standing in for stemming — `dotac:*` finds *dotácia*, *dotácie* and *dotáciu*. The supplier name is folded into the same vector.

Query terms are reduced to `[a-z0-9]` before reaching Postgres, so no `tsquery` operator can be injected. A GIN index keeps queries in the low milliseconds across 248 k rows.

## Maps and charts

The parking map is Leaflet over OpenStreetMap raster tiles. It began as hand-drawn SVG with no basemap, on the reasoning that 24 polygons did not justify a map library. That was wrong: the zones are a small cluster in the middle of a 12 km-wide city, so at city extent they were an unreadable blob, and with no streets there was no way to tell *where* a zone is — the only question a parking map exists to answer. The map now fits to the zones rather than the city.

CARTO's Positron would sit better under coloured polygons, but its CDN burns an "API KEY REQUIRED" watermark across every tile, so it is not keyless in practice. OSM is, within its tile usage policy; a busier site would need its own tile source. Dark mode inverts the tile pane only, so the zone colours survive.

Leaflet reads `window` at module evaluation, so the map cannot be server-rendered at all — `components/zone-map-loader.tsx` exists solely because `next/dynamic({ssr: false})` is not allowed inside a Server Component.

The age pyramid *is* hand-drawn inline SVG, and stays that way: a vertical Recharts bar chart rendered its axes but never painted the diverging bars, and a pyramid is a shape simple enough to place exactly.

Every other chart sets `isAnimationActive={false}`. Recharts animates a chart in on mount, and with a dozen series across several pages that read as charts rendering wrong — half-drawn lines, bars stuck near zero — rather than as charts still arriving. A dashboard of static annual data has nothing to animate.

## What each register adds

**City financial statements** (RÚZ) put the city's own balance sheet next to its published invoices. Beware the comparison: `total_expenses` is accrual accounting cost including depreciation and transfers, while invoices and orders are published documents including VAT. The two will never match, and the page says so.

Two traps, both verified against the bytes. Template **684 is the CONSOLIDATED balance sheet; 690 is the individual one** — the opposite of what a first pass concluded, and they disagree on row indexes and even column counts, so a hard-coded template reads consolidated offsets into individual statements. And Martin filed its 2022 consolidated statement twice, eight months apart, with materially different figures, so the loader keeps the greatest `datumPodania` per (year, consolidated).

**Procurement** (ÚVO) shows what was tendered before the money moved. It carries no price in any listing field, so it cannot be joined to invoices on amount. It is HTML scraping, and ÚVO intermittently takes 26 seconds for a single listing page — which is why pagination derives its page count from the advertised record total rather than stopping at the first empty page. Doing the latter silently collected 60 of 223 records. ÚVO also answers, in bursts, a well-formed "no records" page for authorities that do have tenders; from 18 September 2026 the daily job got zero for Mesto Martin on every run and reported success. Since a tender never leaves the listing, an authority dropping from N stored tenders to zero is now reported as a failed step. Separately, ÚVO intermittently serves GitHub-hosted runners a `<title>Nedostupne</title>` stub for listing and notice pages that answer normally from a Slovak IP minutes later. Between them, the stub and the empty listings failed the procurement step on every daily run from 18 to 26 September 2026, until a manual run 14 minutes after a stubbed one got all 253 tenders.

**Statistics** (DATAcube) supply the long series: Martin's population every year since 1993, average wage in the district, housing completions. The NACE breakdowns in the wage cube OVERLAP — `SPOLU` is the grand total and `B_C_D_E` repeats sections that are also present individually — so anything that sums that column double-counts. Queries filter to one level on purpose.

**Elections** give turnout and the mayoral result. Candidate names, parties and vote counts are stored; nothing about voters, and no candidate addresses or birth dates even where the source file carries them.

Meteoalarm weather warnings were investigated and **rejected on licence grounds**: their terms attach six additional re-use requirements that a batch ETL cannot satisfy, and attribution alone is not enough.

## The city GIS, and two ways it lies quietly

`martin.gisplan.sk` publishes far more than the district outlines this project started with: street lighting, the greenery register, city-owned parcels and schools — 47 795 features in all. The services are not discoverable by guessing. They live under `common/`, not `local/`, and the only way to find them is to read the app launcher's links, fetch each app's `config.php?appconfig=true` and pull the service paths out of that.

Two traps, both of which silently return less than they should:

**A plain GetFeature is capped, per layer, with no marker.** `majetok-c` answers with 50 of its 2 859 rows; `pz-p-ver` with 500 of 11 039. The response says nothing. Every layer's true size therefore comes from a separate `resultType=hits` request, and a load that does not reconcile against it is a hard error.

**`startIndex` paging without `sortBy` repeats and skips rows.** The underlying query has no ORDER BY, so the result set is unstable between requests. Walking `pz-biob-ver` unsorted served exactly its 21 402 rows and yielded only 20 951 distinct ones — adjacent pages overlapped by id and, necessarily, missed others. `sortBy=ogc_fid` makes consecutive pages contiguous and disjoint. Without it, 451 trees would have gone missing and nothing would have said so.

Two of the layer groups earn their place by meeting the rest of the data rather than by being maps. **Mowing** is kept separate from the greenery register because it says what is maintained and by whom — one layer is named, in the source, `Bioprvky — kosenie (Brantner Fatra)`, after the contractor the invoice table shows receiving EUR 72.8 million. **Civil protection** carries the flood zones, which belong next to the Turiec river gauges already on the dashboard.

A layer's switch group is part of its definition, not inferred from its name. An earlier prefix rule (`osv-` → lighting, `pz-` → greenery, everything else → schools) quietly filed all fourteen new layers under "schools" the moment they were added.

Feature bounding boxes are stored as four indexed columns rather than adopting PostGIS: the only spatial question the site asks is "what is in this viewport", and 47 795 features cannot reach a browser in one response. `/api/gis` answers per viewport and caps at 2 500, telling the map when it did so, so a dense layer says "zoom in" instead of quietly drawing a slice.

## Deliberate exclusions

The city publishes more personal data than this project is willing to amplify. An ASP.NET table nobody can search is not the same artefact as a fast, indexed, linkable dashboard.

- **Dog registry** — street, house number, breed and tag number per animal. Not loaded.
- **Tax debtors** — full names, addresses and amounts owed. Not loaded.
- **Contract counterparties** — 73% are natural persons, 9 656 of them grave-plot rentals. Contracts are aggregated to `(year, kind)` totals; no counterparty name is stored.
- **Streets with fewer than six residents** are dropped from the population table. Naming a street with three people on it comes close to naming them.

Invoice and order supplier names *are* kept. Those are business counterparties being paid from public money, which is the point of the dataset.

## Known dead ends

Checked and confirmed unavailable, recorded so nobody re-checks them:

- **No real-time parking occupancy** anywhere in Martin — the map API, the operator's site and the payment gateway were all probed.
- **No GTFS for MHD Martin.** The city bus network publishes no machine-readable timetable.
- **No outage API** from the regional electricity distributor.
- `parkovanie-martin.sk` runs a WAF that rejects the bare `Mozilla/5.0` user agent with HTTP 466.

## Licensing

Mixed, and not uniformly clean:

- eGOV datasets: CC-BY, city of Martin.
- RPO: CC-BY 4.0, declared verbatim in every API response.
- ÚPSVaR, ŠÚ SR: public-sector open data.
- SHMU air and hydrology, `datamesta.martin.sk`, `martin.gisplan.sk`: **no licence is declared**. The GisPlan WFS advertises empty `ows:Fees` and `ows:AccessConstraints` and an unconfigured provider name. All three are published unauthenticated by public bodies and are used here as public-sector information with explicit attribution on the pages that show them.

## Local development

```bash
npm install
docker compose up -d          # Postgres 18 on port 54329
cp .env.example .env.local
npm run etl                   # spending + city facts + geometry, then IČO lookups
npm run etl:live              # air, rivers, unemployment, notices — about a second
npm run dev
```

The spending load takes about 70 seconds. The IČO pass adds up to 250 lookups at 2–5 seconds each, so a cold first run is long; later runs find nothing left to resolve.

## Deployment

Set `DATABASE_URL` to a Neon **pooled** connection string (the host contains `-pooler`) in both Vercel and the repository's GitHub Actions secrets.

Loaded size is 192 MB against Neon's 0.5 GB free tier. Roughly half of that is the search feature, and it is worth knowing the split before adding more of it: the `search_vec` columns hold 50 MB and their GIN indexes another 44 MB, on top of 137 MB of spending rows. Order subject text is already truncated to 300 characters during transform; keeping it in full would add about another 70 MB.

The register tables are negligible by comparison — statistics, procurement and election results together are under 1 MB. Air readings grow by roughly 120 rows a day, river levels by about 200.

A full daily run measured 29.2 minutes, against a 60-minute workflow timeout. Most of that is backfill that converges: the IČO pass and the tender-pricing pass each work through a capped slice per run and shrink to nothing once caught up, leaving roughly 8–10 minutes of permanent work — the spending snapshot, the registers and the 30 GIS layers. If the budget ever gets tight again, lower `MAX_LOOKUPS_PER_RUN` and `TENDER_VALUES_PER_RUN` rather than the timeout; both are designed to be resumed.

GitHub disables scheduled workflows in public repositories after 60 days without commits.

## Licence

Code MIT. Source data belongs to the bodies listed above.
