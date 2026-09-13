-- Martin Open Data — schema
-- Source datasets are full snapshots, so every load replaces the table contents
-- inside a single transaction. There is no natural primary key in the source
-- data (document numbers are reused), hence surrogate keys everywhere.

create table if not exists suppliers (
  id           bigserial primary key,
  norm_key     text not null unique,
  display_name text not null
);

create table if not exists invoices (
  id           bigserial primary key,
  supplier_id  bigint not null references suppliers (id) on delete cascade,
  doc_number   text,
  subject      text,
  amount_eur   numeric(14, 2) not null,
  issued_on    date not null,
  published_on date
);

create table if not exists orders (
  id           bigserial primary key,
  supplier_id  bigint not null references suppliers (id) on delete cascade,
  doc_number   text,
  subject      text,
  amount_eur   numeric(14, 2) not null,
  issued_on    date not null,
  published_on date
);

-- Contracts are aggregated on purpose: 73% of counterparties in the source are
-- natural persons (9 656 of them grave-plot rentals). Only counts and sums are
-- stored, never a counterparty name.
create table if not exists contract_stats (
  year       int not null,
  kind       text not null,
  cnt        int not null,
  amount_eur numeric(16, 2) not null,
  primary key (year, kind)
);

create table if not exists etl_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null,
  detail      jsonb
);

create index if not exists invoices_supplier_idx on invoices (supplier_id);
create index if not exists invoices_issued_idx   on invoices (issued_on);
create index if not exists orders_supplier_idx   on orders (supplier_id);
create index if not exists orders_issued_idx     on orders (issued_on);

-- ---------------------------------------------------------------------------
-- Phase 2
-- ---------------------------------------------------------------------------

-- Diacritic-insensitive search: Slovak has no Postgres stemming dictionary, so
-- search runs on `simple` + unaccent with prefix matching on each term.
create extension if not exists unaccent;

alter table invoices add column if not exists search_vec tsvector;
alter table orders add column if not exists search_vec tsvector;

create index if not exists invoices_search_idx on invoices using gin (search_vec);
create index if not exists orders_search_idx on orders using gin (search_vec);

create table if not exists air_stations (
  station_id int primary key,
  name       text not null,
  lat        double precision,
  lon        double precision
);

create table if not exists air_pollutants (
  pollutant_id text primary key,
  label        text not null
);

-- Unlike the spending snapshots this table ACCUMULATES and must never be
-- truncated: SHMU serves only a rolling 24-hour window, so any history beyond
-- yesterday exists solely because this pipeline kept collecting it.
create table if not exists air_readings (
  station_id  int not null references air_stations (station_id) on delete cascade,
  pollutant   text not null,
  measured_at timestamptz not null,
  value       double precision not null,
  limit_level int,
  primary key (station_id, pollutant, measured_at)
);

create index if not exists air_readings_time_idx on air_readings (measured_at desc);

-- Official notice board, keyed by permalink.
create table if not exists notices (
  link         text primary key,
  title        text not null,
  description  text,
  published_at timestamptz not null
);

create index if not exists notices_published_idx on notices (published_at desc);

-- ---------------------------------------------------------------------------
-- Wave 3 — enrichment, geometry, city facts
-- ---------------------------------------------------------------------------

-- RPO lookup cache. Deliberately NOT truncated with the spending snapshot:
-- norm_key is stable across reloads, and re-querying 5 000 suppliers daily
-- would hammer a public national service for an answer that never changes.
create table if not exists supplier_ico (
  norm_key     text primary key,
  ico          text,
  matched_name text,
  former_names text[],
  matched      boolean not null,
  checked_at   timestamptz not null default now()
);

-- Near-static geometry, replaced wholesale on each load.
create table if not exists parking_zones (
  id       int primary key,
  zone     text not null,
  colour   text,
  geometry jsonb not null
);

create table if not exists city_districts (
  id       int primary key,
  name     text not null,
  geometry jsonb not null
);

create table if not exists population_by_street (
  street          text primary key,
  permanent       int,
  temporary       int,
  women           int,
  men             int,
  pre_productive  int,
  productive      int,
  post_productive int
);

create table if not exists population_by_age (
  age   int primary key,
  total int,
  men   int,
  women int
);

-- Monthly file at a fixed URL, so each run adds one period. Accumulates.
create table if not exists unemployment (
  territory_code text not null,
  territory_name text not null,
  period         date not null,
  registered     int,
  available      int,
  share_pct      numeric(6, 2),
  primary key (territory_code, period)
);

create table if not exists hydro_stations (
  station_id int primary key,
  name       text not null
);

-- Accumulates like air_readings: SHMU serves a ~10-day rolling window.
create table if not exists hydro_readings (
  station_id  int not null references hydro_stations (station_id) on delete cascade,
  measured_at timestamptz not null,
  level_cm    numeric(8, 1) not null,
  primary key (station_id, measured_at)
);

create index if not exists hydro_readings_time_idx on hydro_readings (measured_at desc);
create index if not exists unemployment_period_idx on unemployment (period desc);

-- ---------------------------------------------------------------------------
-- Wave 4 — city financials, procurement, statistics, elections
-- ---------------------------------------------------------------------------

-- Mesto Martin's own filed financial statements (Register účtovných závierok,
-- Ministerstvo financií SR). This table ACCUMULATES and must never be truncated.
-- RÚZ re-serves the whole 2013→ history every run, so a wholesale replace would
-- refill it on a full backfill — but the natural key exists precisely so an
-- amended re-filing overwrites its year in place: Martin filed its 2022
-- consolidated statement twice (id 5600072 on 2023-06-21, total assets
-- 182 072 156.12 / profit after tax 1 594 128.65, and id 5712071 on 2023-11-23,
-- 180 703 168.33 / 1 566 593.89) and only the later one may survive. The second
-- reason is that the routine run is meant to be `{ since: year - 3 }`, which
-- only visits the recent years — a truncate there would wipe 2013–2022 nightly.
--
-- Both filings per year are stored and labelled by `consolidated`: the
-- individual statement is the city office alone — the same perimeter as the
-- invoices and orders tables — while the consolidated one adds the city's
-- subsidiaries and runs roughly 1.5× larger. Never chart the two as one series.
-- `balance_template_id` / `income_template_id` record which ministry form each
-- figure was read from (690+727 individual, 684+696 consolidated since 2014;
-- 522+521 and 11+12 for 2013) so a row's provenance stays checkable.
--
-- `statement_id` is deliberately NOT part of the key: including it would chart
-- 2022-consolidated twice, once per filing.
--
-- filed_on / prepared_on MUST stay nullable. Verified on the wire 2026-09-13:
-- the two 2013 statements (2129920 consolidated, 1840970 individual) carry
-- neither datumPodania nor datumZostavenia, so 2 of the 26 rows land NULL.
-- Both are Postgres `date` and the fetcher hands them over as plain
-- "YYYY-MM-DD" strings — never Date objects, never .toISOString().
create table if not exists city_financials (
  fiscal_year         int not null,
  consolidated        boolean not null,
  statement_id        bigint not null,
  filed_on            date,
  prepared_on         date,
  balance_template_id int not null,
  income_template_id  int not null,
  total_assets_net    numeric(16, 2) not null,
  non_current_assets  numeric(16, 2) not null,
  current_assets      numeric(16, 2) not null,
  equity              numeric(16, 2) not null,
  liabilities         numeric(16, 2) not null,
  bank_loans          numeric(16, 2) not null,
  deferred_income     numeric(16, 2) not null,
  total_expenses      numeric(16, 2) not null,
  total_revenues      numeric(16, 2) not null,
  profit_before_tax   numeric(16, 2) not null,
  profit_after_tax    numeric(16, 2) not null,
  primary key (fiscal_year, consolidated)
);

-- No secondary index: (fiscal_year, consolidated) already orders every query
-- this table serves, and it holds 26 rows (13 fiscal years × 2 filings,
-- growing +2/year). Largest stored figure to date is 205 550 601.43, well
-- inside numeric(16,2).

-- Provenance of each stored figure. Row addresses are given as
-- (table, oznacenie, label) — the line NUMBERS below differ per template, which
-- is exactly why the fetcher matches on label and never hard-codes them. Every
-- cisloRiadku here was re-read from the live sablona payloads on 2026-09-13.
--   total_assets_net    súvaha "Strana aktív",  no oznacenie, "SPOLU MAJETOK"
--                       (line 1 in all four templates), Netto current column
--   non_current_assets  súvaha "Strana aktív",  A.,    "Neobežný majetok"   (line 2)
--   current_assets      súvaha "Strana aktív",  B.,    "Obežný majetok"     (line 33 in 690/522, line 35 in 684/11)
--   equity              súvaha "Strana pasív",  A.,    "Vlastné imanie"     (line 116 / 119)
--   liabilities         súvaha "Strana pasív",  B.,    "Záväzky súčet"      (line 126 / 130)
--   bank_loans          súvaha "Strana pasív",  B.V.,  "Bankové úvery a výpomoci súčet" (line 173 / 178) — a subset of liabilities
--   deferred_income     súvaha "Strana pasív",  C.,    "Časové rozlíšenie súčet" (line 180 / 185) — mostly unamortised capital transfers
--   total_expenses      VZaS   "Náklady",       none,  "Účtové skupiny 50 - 58 … súčet" (line 64 / 65), column "Spolu"
--   total_revenues      VZaS   "Výnosy",        none,  "Účtová trieda 6 … súčet"        (line 134 / 136), column "Spolu"
--   profit_before_tax   VZaS   "Výnosy",        none,  "Výsledok hospodárenia pred zdanením" (line 135 / 137)
--   profit_after_tax    VZaS   "Výnosy",        none,  "Výsledok hospodárenia po zdanení"    (line 138 / 140)
-- The 2013 forms (521, 12) spell the two totals "… celkom súčet"; the fetcher
-- matches on a label stem so both spellings resolve.
--
-- Three identities are asserted per filing, and all 26 loaded filings pass
-- (27 statements are fetched; the superseded 2022 consolidated one is dropped
-- before its reports are ever requested, so it is not among the 26 asserted):
--   total_assets_net = "VLASTNÉ IMANIE A ZÁVÄZKY"
--   total_assets_net = equity + liabilities + deferred_income
--                      + "Vzťahy k účtom klientov ŠP" (D., always 0 or blank for Martin)
--   total_revenues - total_expenses = profit_before_tax
--
-- Load it with an upsert, e.g.
--   insert into city_financials (...) values (...)
--   on conflict (fiscal_year, consolidated) do update set ...
-- and pass filed_on / prepared_on as the plain strings the fetcher returns.
-- ---------------------------------------------------------------------------
-- ÚVO — public procurement (uvo.gov.sk). HTML scrape, no API exists.
-- Verified against the live site 2026-09-13.
-- ---------------------------------------------------------------------------

-- ACCUMULATES — upsert on uvo_id, never truncate.
-- The search listing re-lists every tender on each run (223 of 223 collected
-- end-to-end), so a wholesale replace would load correctly too. It must still
-- not be used: everything below `via_evo` is filled by a capped incremental
-- pass that costs one page load per tender plus one per Vestník notice
-- (~1000 loads to backfill Mesto Martin alone, and ÚVO answered individual
-- pages in 0.3-33 s during the measured sweep). Truncating would discard that
-- and re-scrape it nightly — the same reason supplier_ico is kept out of the
-- spending snapshot.
--
-- created_at / published_at arrive as NAIVE local wall clock ("2026-08-05
-- 07:55:00"): the source prints no zone and the CI runner is UTC, so insert
-- them under `set local time zone 'Europe/Bratislava'`.
--
-- No contact person, e-mail, phone or counterparty name is stored. Those fields
-- exist in the Vestník notice body and identify private individuals.
create table if not exists uvo_tenders (
  uvo_id            bigint primary key,
  authority_ico     text not null,
  authority         text not null,
  name              text not null,
  cpv_label         text,
  nuts_label        text,
  updated_on        date not null,
  via_evo           boolean not null default false,
  status            text,
  kind              text,
  procedure_type    text,
  cpv_codes         text[],
  nuts_codes        text[],
  eu_funded         boolean,
  e_auction         boolean,
  created_at        timestamptz,
  published_at      timestamptz,
  -- The `updated_on` the detail pass last saw; refetch the detail only when
  -- the listing's `updated_on` has moved past it.
  detail_updated_on date,
  first_seen_at     timestamptz not null default now(),
  -- "Predpokladaná hodnota" is the ONLY money ÚVO publishes for a tender, and
  -- it lives inside the bulletin notices — neither the search listing nor the
  -- tender detail page has a price field at all. Filling it costs roughly
  -- three extra requests per tender against a server that intermittently
  -- takes 26 s for one page, so a separate incremental pass does it.
  --
  -- Measured on an 18-tender sample spread over 2016–2026: 14 of them (78%)
  -- yield an estimate and the other 4 carry no "predpokladaná hodnota" block
  -- in any of their notices. value_checked_at is therefore the "already
  -- looked" flag — without it those 4 would be re-fetched on every run.
  --
  -- numeric(16, 2) deliberately rounds the legacy form's four-decimal
  -- rendering ("50 000,0000").
  estimated_value_eur numeric(16, 2),
  value_notice_code   text,
  value_checked_at    timestamptz
);

create table if not exists datacube_series (
  cube            text not null,
  territory_code  text not null,
  territory_name  text not null,
  year            int not null,
  indicator       text not null,
  indicator_label text not null,
  breakdown       text not null default '',
  breakdown_label text,
  -- double precision, not numeric: these are published statistics to plot,
  -- not money to add up, and node-postgres hands a `numeric` back as a string
  -- that every chart would have to re-parse.
  value           double precision not null,
  source_updated  date not null,
  primary key (cube, territory_code, year, indicator, breakdown)
);

create index if not exists datacube_series_lookup_idx
  on datacube_series (cube, indicator, year);
-- ---------------------------------------------------------------------------
-- Municipal elections (volby.statistics.sk — OSO bulk CSV export)
-- ---------------------------------------------------------------------------

-- ACCUMULATES — never truncated. Each election publishes its own file set,
-- frozen on publication day (the 2022 ZIP still carries Last-Modified
-- "Sun, 30 Oct 2022 11:04:20 GMT" and is never revised), and the 2026 download
-- will not contain 2022. A wholesale replace would therefore delete the
-- multi-election series this table exists for. Loads upsert on the natural key.
--
-- CAVEAT ON THIS KEY, and it is the reason the fetcher asserts uniqueness
-- before returning: unlike the candidate key below, the source does NOT state a
-- key for turnout, and OKRSOK is not unique within (OBEC, VOOBEC) everywhere.
-- In Košice (obec 599981) precinct numbers restart inside each mestská časť —
-- a column tab02bf does not carry — so its 198 rows collapse to 187 distinct
-- keys. Košice is the only such obec in 2022 (Bratislava's 394 are distinct,
-- Martin's 52 are distinct), so the key is right for every obec this project
-- loads; it is not right for a naive national build. Extending nationally means
-- either excluding Košice or sourcing the mestská časť from elsewhere and
-- adding it to this key.
create table if not exists election_turnout (
  election_year         int  not null,
  obec_code             text not null,
  ward                  int  not null,
  precinct              int  not null,
  registered            int  not null,
  voted                 int  not null,
  envelopes             int  not null,
  valid_council_ballots int  not null,
  valid_mayor_ballots   int  not null,
  primary key (election_year, obec_code, ward, precinct)
);

-- ACCUMULATES for the same reason, upserted on the same natural key. A mayoral
-- candidate is city-wide and is stored with ward 0; a councillor is unique
-- within (ward, ballot_no), which is what the source states: tab_info says
-- "Kandidáta na starostu jednoznačne identifikuje kombinácia stĺpcov OBEC a
-- PC_HL" and "Kandidáta na poslanca … OBEC, VOOBEC a PC_HL". Both hold
-- nationally with zero duplicates — 6 767 mayoral and 42 216 council
-- candidacies in 2022.
--
-- Vote shares are deliberately NOT stored. The source percentage for a
-- councillor is that candidate's share of every preference vote cast in one
-- precinct, so it is neither a share of voters nor summable across precincts;
-- any share the dashboard shows is computed from these counts.
--
-- Privacy: the source also carries each candidate's age on polling day and
-- declared occupation. Neither is loaded, nor is the academic title. Name,
-- political subject, votes and the elected flag are public facts about people
-- who stood for public office. No voter-level data exists in the source — the
-- finest grain anywhere in the eight tables is a precinct count.
create table if not exists election_candidates (
  election_year int     not null,
  obec_code     text    not null,
  office        text    not null check (office in ('mayor', 'councillor')),
  ward          int     not null,
  ballot_no     int     not null,
  first_name    text    not null,
  last_name     text    not null,
  party         text    not null,
  votes         int     not null,
  elected       boolean not null,
  withdrawn     boolean not null,
  primary key (election_year, obec_code, office, ward, ballot_no)
);

create index if not exists election_candidates_result_idx
  on election_candidates (election_year, obec_code, office, votes desc);

-- Migration for databases created before the tender-value pass existed.
alter table uvo_tenders add column if not exists estimated_value_eur numeric(16, 2);
alter table uvo_tenders add column if not exists value_notice_code text;
alter table uvo_tenders add column if not exists value_checked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Wave 5 — GIS layers from martin.gisplan.sk
-- ---------------------------------------------------------------------------

-- SNAPSHOT, scoped per layer: each layer is re-read whole and replaces only its
-- own rows, so one unreachable service cannot wipe the others.
--
-- The count is stored alongside because a plain WFS GetFeature on this server
-- is silently capped per layer — majetok-c answers with 50 of its 2 859 rows,
-- pz-p-ver with 500 of 11 039 — and the truncated response carries no marker.
-- feature_count comes from resultType=hits and is what the loader reconciles
-- against; a mismatch is a hard error, not a shrug.
create table if not exists gis_layers (
  layer         text primary key,
  service       text not null,
  title         text not null,
  -- The switch group comes from the layer definition, not from guessing at the
  -- name prefix: a prefix rule silently filed every unrecognised layer under
  -- whatever the fallback happened to be.
  layer_group   text not null,
  feature_count int not null,
  fetched_at    timestamptz not null default now()
);

create table if not exists gis_features (
  layer      text not null references gis_layers (layer) on delete cascade,
  feature_id bigint not null,
  label      text,
  props      jsonb,
  geometry   jsonb not null,
  -- Bounding box as plain columns rather than PostGIS: the only spatial query
  -- this project makes is "what falls in the current viewport", and 47 795
  -- features cannot be shipped to a browser in one go. Four indexed floats
  -- answer that without taking on an extension Neon would have to provide.
  min_lon    double precision not null,
  min_lat    double precision not null,
  max_lon    double precision not null,
  max_lat    double precision not null,
  primary key (layer, feature_id)
);

create index if not exists gis_features_bbox_idx
  on gis_features (layer, min_lon, max_lon, min_lat, max_lat);

create index if not exists gis_features_layer_idx on gis_features (layer);

alter table gis_layers add column if not exists layer_group text not null default 'Ostatné';
