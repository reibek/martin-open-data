import { query } from "./db"
import { buildTsQuery } from "./text"

/** pg returns `numeric` as a string to avoid precision loss; widen deliberately. */
const toNumber = (value: string | number | null) => Number(value ?? 0)

export type Overview = {
  latestYear: number
  latestYearTotal: number
  latestYearCount: number
  allTimeTotal: number
  supplierCount: number
  documentCount: number
  topSupplierName: string
  topSupplierTotal: number
}

export async function getOverview(): Promise<Overview> {
  const [totals] = await query<{
    latest_year: number
    latest_year_total: string
    latest_year_count: string
    all_time_total: string
    document_count: string
  }>(`
    with spend as (
      select issued_on, amount_eur from invoices
      union all
      select issued_on, amount_eur from orders
    ),
    latest as (select max(extract(year from issued_on))::int as yr from spend)
    select
      latest.yr as latest_year,
      coalesce(sum(amount_eur) filter (where extract(year from issued_on) = latest.yr), 0) as latest_year_total,
      count(*) filter (where extract(year from issued_on) = latest.yr) as latest_year_count,
      coalesce(sum(amount_eur), 0) as all_time_total,
      count(*) as document_count
    from spend cross join latest
    group by latest.yr
  `)

  const [suppliers] = await query<{ supplier_count: string }>(
    "select count(*) as supplier_count from suppliers"
  )

  const [top] = await query<{ display_name: string; total: string }>(`
    select s.display_name, sum(i.amount_eur) as total
    from invoices i join suppliers s on s.id = i.supplier_id
    group by s.display_name
    order by total desc
    limit 1
  `)

  return {
    latestYear: totals.latest_year,
    latestYearTotal: toNumber(totals.latest_year_total),
    latestYearCount: toNumber(totals.latest_year_count),
    allTimeTotal: toNumber(totals.all_time_total),
    supplierCount: toNumber(suppliers.supplier_count),
    documentCount: toNumber(totals.document_count),
    topSupplierName: top?.display_name ?? "—",
    topSupplierTotal: toNumber(top?.total ?? 0),
  }
}

export type YearSpend = { year: number; invoices: number; orders: number }

export async function getSpendByYear(): Promise<YearSpend[]> {
  const rows = await query<{ year: number; invoices: string; orders: string }>(`
    select
      extract(year from issued_on)::int as year,
      coalesce(sum(amount_eur) filter (where kind = 'invoice'), 0) as invoices,
      coalesce(sum(amount_eur) filter (where kind = 'order'), 0) as orders
    from (
      select issued_on, amount_eur, 'invoice' as kind from invoices
      union all
      select issued_on, amount_eur, 'order' as kind from orders
    ) spend
    group by 1
    order by 1
  `)
  return rows.map((row) => ({
    year: row.year,
    invoices: toNumber(row.invoices),
    orders: toNumber(row.orders),
  }))
}

export type TopSupplier = {
  normKey: string
  displayName: string
  invoiceCount: number
  total: number
  firstYear: number
  lastYear: number
}

export async function getTopSuppliers(limit = 25): Promise<TopSupplier[]> {
  const rows = await query<{
    norm_key: string
    display_name: string
    invoice_count: string
    total: string
    first_year: number
    last_year: number
  }>(
    `
    select
      s.norm_key,
      s.display_name,
      count(*) as invoice_count,
      sum(i.amount_eur) as total,
      min(extract(year from i.issued_on))::int as first_year,
      max(extract(year from i.issued_on))::int as last_year
    from invoices i join suppliers s on s.id = i.supplier_id
    group by s.norm_key, s.display_name
    order by total desc
    limit $1
  `,
    [limit]
  )
  return rows.map((row) => ({
    normKey: row.norm_key,
    displayName: row.display_name,
    invoiceCount: toNumber(row.invoice_count),
    total: toNumber(row.total),
    firstYear: row.first_year,
    lastYear: row.last_year,
  }))
}

export type SupplierDetail = {
  normKey: string
  displayName: string
  invoiceTotal: number
  invoiceCount: number
  orderTotal: number
  orderCount: number
  byYear: { year: number; total: number; count: number }[]
}

export async function getSupplier(
  normKey: string
): Promise<SupplierDetail | null> {
  const [supplier] = await query<{
    id: string
    norm_key: string
    display_name: string
  }>("select id, norm_key, display_name from suppliers where norm_key = $1", [
    normKey,
  ])
  if (!supplier) return null

  const [totals] = await query<{
    invoice_total: string
    invoice_count: string
    order_total: string
    order_count: string
  }>(
    `
    select
      coalesce((select sum(amount_eur) from invoices where supplier_id = $1), 0) as invoice_total,
      (select count(*) from invoices where supplier_id = $1) as invoice_count,
      coalesce((select sum(amount_eur) from orders where supplier_id = $1), 0) as order_total,
      (select count(*) from orders where supplier_id = $1) as order_count
  `,
    [supplier.id]
  )

  const byYear = await query<{ year: number; total: string; count: string }>(
    `
    select extract(year from issued_on)::int as year, sum(amount_eur) as total, count(*) as count
    from invoices where supplier_id = $1
    group by 1 order by 1
  `,
    [supplier.id]
  )

  return {
    normKey: supplier.norm_key,
    displayName: supplier.display_name,
    invoiceTotal: toNumber(totals.invoice_total),
    invoiceCount: toNumber(totals.invoice_count),
    orderTotal: toNumber(totals.order_total),
    orderCount: toNumber(totals.order_count),
    byYear: byYear.map((row) => ({
      year: row.year,
      total: toNumber(row.total),
      count: toNumber(row.count),
    })),
  }
}

export type SupplierInvoice = {
  id: number
  docNumber: string | null
  subject: string | null
  amount: number
  issuedOn: string
}

export async function getSupplierInvoices(
  normKey: string,
  limit = 50
): Promise<SupplierInvoice[]> {
  const rows = await query<{
    id: string
    doc_number: string | null
    subject: string | null
    amount_eur: string
    issued_on: string
  }>(
    `
    select i.id, i.doc_number, i.subject, i.amount_eur, i.issued_on
    from invoices i join suppliers s on s.id = i.supplier_id
    where s.norm_key = $1
    order by i.issued_on desc, i.id desc
    limit $2
  `,
    [normKey, limit]
  )
  return rows.map((row) => ({
    id: Number(row.id),
    docNumber: row.doc_number,
    subject: row.subject,
    amount: toNumber(row.amount_eur),
    issuedOn: row.issued_on,
  }))
}

export async function getLastRun(): Promise<{
  finishedAt: string
  status: string
} | null> {
  const [run] = await query<{ finished_at: Date | null; status: string }>(
    "select finished_at, status from etl_runs where status = 'ok' order by id desc limit 1"
  )
  if (!run?.finished_at) return null
  return { finishedAt: run.finished_at.toISOString(), status: run.status }
}

// ---------------------------------------------------------------------------
// Phase 2
// ---------------------------------------------------------------------------

/** SHMU pollutant codes for the two particulate series worth charting. */
const PM10 = "t24001"
const PM25 = "t39001"

export type SearchTable = "invoices" | "orders"

export type SearchHit = {
  id: number
  supplierName: string
  supplierKey: string
  subject: string | null
  amount: number
  issuedOn: string
}

export async function searchCounts(
  input: string
): Promise<{ invoices: number; orders: number }> {
  const tsQuery = buildTsQuery(input)
  if (!tsQuery) return { invoices: 0, orders: 0 }
  const [row] = await query<{ invoices: string; orders: string }>(
    `select
       (select count(*) from invoices where search_vec @@ to_tsquery('simple', $1)) as invoices,
       (select count(*) from orders where search_vec @@ to_tsquery('simple', $1)) as orders`,
    [tsQuery]
  )
  return { invoices: toNumber(row.invoices), orders: toNumber(row.orders) }
}

export async function searchDocuments(
  table: SearchTable,
  input: string,
  page: number,
  pageSize = 25
): Promise<SearchHit[]> {
  const tsQuery = buildTsQuery(input)
  if (!tsQuery) return []
  // `table` is a closed union, so interpolating it cannot inject SQL.
  const rows = await query<{
    id: string
    display_name: string
    norm_key: string
    subject: string | null
    amount_eur: string
    issued_on: string
  }>(
    `select d.id, s.display_name, s.norm_key, d.subject, d.amount_eur, d.issued_on
     from ${table} d join suppliers s on s.id = d.supplier_id
     where d.search_vec @@ to_tsquery('simple', $1)
     order by d.issued_on desc, d.id desc
     limit $2 offset $3`,
    [tsQuery, pageSize, Math.max(0, page - 1) * pageSize]
  )
  return rows.map((row) => ({
    id: Number(row.id),
    supplierName: row.display_name,
    supplierKey: row.norm_key,
    subject: row.subject,
    amount: toNumber(row.amount_eur),
    issuedOn: row.issued_on,
  }))
}

export type AirPoint = {
  measuredAt: string
  pm10: number | null
  pm25: number | null
}

export async function getAirSeries(hours = 48): Promise<AirPoint[]> {
  const rows = await query<{
    measured_at: Date
    pm10: string | null
    pm25: string | null
  }>(
    `select measured_at,
            max(value) filter (where pollutant = $1) as pm10,
            max(value) filter (where pollutant = $2) as pm25
     from air_readings
     where measured_at > now() - make_interval(hours => $3)
     group by measured_at
     order by measured_at`,
    [PM10, PM25, hours]
  )
  return rows.map((row) => ({
    measuredAt: row.measured_at.toISOString(),
    pm10: row.pm10 === null ? null : Number(row.pm10),
    pm25: row.pm25 === null ? null : Number(row.pm25),
  }))
}

export type AirLatest = {
  stationName: string
  measuredAt: string
  pm10: number | null
  pm25: number | null
  historyHours: number
}

export async function getAirLatest(): Promise<AirLatest | null> {
  const [row] = await query<{
    station_name: string
    measured_at: Date
    pm10: string | null
    pm25: string | null
    history_hours: string
  }>(
    `with newest as (select max(measured_at) as at from air_readings)
     select st.name as station_name,
            newest.at as measured_at,
            max(r.value) filter (where r.pollutant = $1) as pm10,
            max(r.value) filter (where r.pollutant = $2) as pm25,
            (select round(extract(epoch from (max(measured_at) - min(measured_at))) / 3600)
             from air_readings) as history_hours
     from air_readings r
     cross join newest
     join air_stations st on st.station_id = r.station_id
     where r.measured_at = newest.at
     group by st.name, newest.at`,
    [PM10, PM25]
  )
  if (!row) return null
  return {
    stationName: row.station_name,
    measuredAt: row.measured_at.toISOString(),
    pm10: row.pm10 === null ? null : Number(row.pm10),
    pm25: row.pm25 === null ? null : Number(row.pm25),
    historyHours: toNumber(row.history_hours),
  }
}

export type Notice = {
  link: string
  title: string
  description: string | null
  publishedAt: string
}

export async function getNotices(limit = 8): Promise<Notice[]> {
  const rows = await query<{
    link: string
    title: string
    description: string | null
    published_at: Date
  }>(
    `select link, title, description, published_at
     from notices order by published_at desc limit $1`,
    [limit]
  )
  return rows.map((row) => ({
    link: row.link,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Wave 3 — geometry, city facts, enrichment
// ---------------------------------------------------------------------------

export type GeoPolygon = { type: "Polygon"; coordinates: [number, number][][] }

export type ParkingZone = {
  id: number
  zone: string
  colour: string | null
  geometry: GeoPolygon
}

export type District = { id: number; name: string; geometry: GeoPolygon }

export async function getParkingZones(): Promise<ParkingZone[]> {
  return (
    await query<{
      id: number
      zone: string
      colour: string | null
      geometry: GeoPolygon
    }>("select id, zone, colour, geometry from parking_zones order by id")
  ).map((row) => ({ ...row }))
}

export async function getDistricts(): Promise<District[]> {
  return (
    await query<{ id: number; name: string; geometry: GeoPolygon }>(
      "select id, name, geometry from city_districts order by id"
    )
  ).map((row) => ({ ...row }))
}

export type StreetPopulation = {
  street: string
  permanent: number
  women: number
  men: number
  preProductive: number
  productive: number
  postProductive: number
}

export async function getPopulationByStreet(
  limit = 30
): Promise<StreetPopulation[]> {
  const rows = await query<{
    street: string
    permanent: number
    women: number
    men: number
    pre_productive: number
    productive: number
    post_productive: number
  }>(
    `select street, permanent, women, men, pre_productive, productive, post_productive
     from population_by_street order by permanent desc limit $1`,
    [limit]
  )
  return rows.map((row) => ({
    street: row.street,
    permanent: row.permanent,
    women: row.women,
    men: row.men,
    preProductive: row.pre_productive,
    productive: row.productive,
    postProductive: row.post_productive,
  }))
}

export type AgeBand = { age: number; men: number; women: number }

export async function getAgePyramid(): Promise<AgeBand[]> {
  const rows = await query<{ age: number; men: number; women: number }>(
    "select age, men, women from population_by_age order by age"
  )
  return rows.map((row) => ({ age: row.age, men: row.men, women: row.women }))
}

export type CityTotals = {
  residents: number
  men: number
  women: number
  streets: number
}

export async function getCityTotals(): Promise<CityTotals | null> {
  const [row] = await query<{
    residents: string
    men: string
    women: string
    streets: string
  }>(
    `select coalesce(sum(total), 0) as residents,
            coalesce(sum(men), 0) as men,
            coalesce(sum(women), 0) as women,
            (select count(*) from population_by_street) as streets
     from population_by_age`
  )
  if (!row || toNumber(row.residents) === 0) return null
  return {
    residents: toNumber(row.residents),
    men: toNumber(row.men),
    women: toNumber(row.women),
    streets: toNumber(row.streets),
  }
}

export type UnemploymentPoint = {
  period: string
  territoryCode: string
  territoryName: string
  sharePct: number | null
  registered: number | null
}

export async function getUnemployment(): Promise<UnemploymentPoint[]> {
  const rows = await query<{
    period: string
    territory_code: string
    territory_name: string
    share_pct: string | null
    registered: number | null
  }>(
    `select period, territory_code, territory_name, share_pct, registered
     from unemployment order by period, territory_code`
  )
  return rows.map((row) => ({
    period: row.period,
    territoryCode: row.territory_code,
    territoryName: row.territory_name,
    sharePct: row.share_pct === null ? null : Number(row.share_pct),
    registered: row.registered,
  }))
}

export type HydroSeries = {
  stationId: number
  name: string
  latest: { measuredAt: string; levelCm: number } | null
  points: { measuredAt: string; levelCm: number }[]
}

export async function getHydro(hours = 72): Promise<HydroSeries[]> {
  const rows = await query<{
    station_id: number
    name: string
    measured_at: Date
    level_cm: string
  }>(
    `select r.station_id, s.name, r.measured_at, r.level_cm
     from hydro_readings r join hydro_stations s on s.station_id = r.station_id
     where r.measured_at > now() - make_interval(hours => $1)
     order by r.station_id, r.measured_at`,
    [hours]
  )

  const byStation = new Map<number, HydroSeries>()
  for (const row of rows) {
    const series =
      byStation.get(row.station_id) ??
      ({
        stationId: row.station_id,
        name: row.name,
        latest: null,
        points: [],
      } as HydroSeries)
    const point = {
      measuredAt: row.measured_at.toISOString(),
      levelCm: Number(row.level_cm),
    }
    series.points.push(point)
    series.latest = point
    byStation.set(row.station_id, series)
  }
  return [...byStation.values()]
}

export type SupplierIdentity = {
  ico: string | null
  matchedName: string | null
  formerNames: string[]
}

export async function getSupplierIdentity(
  normKey: string
): Promise<SupplierIdentity | null> {
  const [row] = await query<{
    ico: string | null
    matched_name: string | null
    former_names: string[] | null
    matched: boolean
  }>(
    "select ico, matched_name, former_names, matched from supplier_ico where norm_key = $1",
    [normKey]
  )
  if (!row || !row.matched) return null
  return {
    ico: row.ico,
    matchedName: row.matched_name,
    formerNames: row.former_names ?? [],
  }
}

// ---------------------------------------------------------------------------
// Wave 4 — city financials, procurement, elections
// ---------------------------------------------------------------------------

export type FinancialYear = {
  fiscalYear: number
  totalAssets: number
  revenues: number
  expenses: number
  profit: number
  bankLoans: number
  filedOn: string
}

export async function getCityFinancials(
  consolidated = false
): Promise<FinancialYear[]> {
  const rows = await query<{
    fiscal_year: number
    total_assets_net: string | null
    total_revenues: string | null
    total_expenses: string | null
    profit_after_tax: string | null
    bank_loans: string | null
    filed_on: string | null
  }>(
    `select fiscal_year, total_assets_net, total_revenues, total_expenses,
            profit_after_tax, bank_loans, filed_on
     from city_financials where consolidated = $1 order by fiscal_year`,
    [consolidated]
  )
  return rows.map((row) => ({
    fiscalYear: row.fiscal_year,
    totalAssets: toNumber(row.total_assets_net),
    revenues: toNumber(row.total_revenues),
    expenses: toNumber(row.total_expenses),
    profit: toNumber(row.profit_after_tax),
    bankLoans: toNumber(row.bank_loans),
    filedOn: row.filed_on ?? "",
  }))
}

export type Tender = {
  uvoId: number
  name: string
  cpvLabel: string | null
  updatedOn: string
  viaEvo: boolean
  estimatedValueEur: number | null
  authority: string
}

export async function getTenders(limit = 50, offset = 0): Promise<Tender[]> {
  const rows = await query<{
    uvo_id: number
    name: string
    cpv_label: string | null
    updated_on: string
    via_evo: boolean
    estimated_value_eur: string | null
    authority: string
  }>(
    `select uvo_id, name, cpv_label, updated_on, via_evo, estimated_value_eur, authority
     from uvo_tenders order by updated_on desc limit $1 offset $2`,
    [limit, offset]
  )
  return rows.map((row) => ({
    uvoId: row.uvo_id,
    name: row.name,
    cpvLabel: row.cpv_label,
    updatedOn: row.updated_on,
    viaEvo: row.via_evo,
    estimatedValueEur:
      row.estimated_value_eur === null ? null : Number(row.estimated_value_eur),
    authority: row.authority,
  }))
}

export async function getTenderStats(): Promise<{
  total: number
  firstYear: number
  lastYear: number
  topCpv: { label: string; count: number }[]
}> {
  const [totals] = await query<{
    total: string
    first_year: number
    last_year: number
  }>(
    `select count(*) as total,
            min(extract(year from updated_on))::int as first_year,
            max(extract(year from updated_on))::int as last_year
     from uvo_tenders`
  )
  const topCpv = await query<{ cpv_label: string; count: string }>(
    `select cpv_label, count(*) as count from uvo_tenders
     where cpv_label is not null group by cpv_label order by count desc limit 6`
  )
  return {
    total: toNumber(totals?.total ?? 0),
    firstYear: totals?.first_year ?? 0,
    lastYear: totals?.last_year ?? 0,
    topCpv: topCpv.map((row) => ({
      label: row.cpv_label,
      count: toNumber(row.count),
    })),
  }
}

export type ElectionSummary = {
  year: number
  registered: number
  voted: number
  turnoutPct: number
  mayor: { name: string; party: string; votes: number } | null
  runnerUp: { name: string; party: string; votes: number } | null
}

export async function getElectionSummary(): Promise<ElectionSummary | null> {
  const [turnout] = await query<{
    election_year: number
    registered: string
    voted: string
  }>(
    `select election_year, sum(registered) as registered, sum(voted) as voted
     from election_turnout group by election_year order by election_year desc limit 1`
  )
  if (!turnout) return null

  const mayors = await query<{
    first_name: string
    last_name: string
    party: string | null
    votes: number
    elected: boolean
  }>(
    `select first_name, last_name, party, votes, elected
     from election_candidates
     where office = 'mayor' and election_year = $1
     order by votes desc limit 2`,
    [turnout.election_year]
  )
  const toPerson = (row: (typeof mayors)[number] | undefined) =>
    row
      ? {
          name: `${row.first_name} ${row.last_name}`,
          party: row.party ?? "",
          votes: row.votes,
        }
      : null

  const registered = toNumber(turnout.registered)
  const voted = toNumber(turnout.voted)
  return {
    year: turnout.election_year,
    registered,
    voted,
    turnoutPct:
      registered > 0 ? Math.round((1000 * voted) / registered) / 10 : 0,
    mayor: toPerson(mayors[0]),
    runnerUp: toPerson(mayors[1]),
  }
}

// ---------------------------------------------------------------------------
// Wave 4 — ŠÚ SR DATAcube series
// ---------------------------------------------------------------------------

export type DemographyYear = {
  year: number
  population: number | null
  births: number | null
  deaths: number | null
  migration: number | null
}

/**
 * Martin's own demography, 1993 onwards. A null is how the source publishes
 * both "no value" and, occasionally, an exact zero — so nulls are passed
 * through rather than coalesced, and the charts skip them.
 */
export async function getDemography(): Promise<DemographyYear[]> {
  const rows = await query<{
    year: number
    population: string | null
    births: string | null
    deaths: string | null
    migration: string | null
  }>(
    `select year,
            max(value) filter (where indicator = 'IN010115') as population,
            max(value) filter (where indicator = 'IN010106') as births,
            max(value) filter (where indicator = 'IN010061') as deaths,
            max(value) filter (where indicator = 'IN010080') as migration
     from datacube_series where cube = 'om7103rr'
     group by year order by year`
  )
  const num = (value: string | null) => (value === null ? null : Number(value))
  return rows.map((row) => ({
    year: row.year,
    population: num(row.population),
    births: num(row.births),
    deaths: num(row.deaths),
    migration: num(row.migration),
  }))
}

export type WageYear = { year: number; wage: number }

/**
 * Average monthly wage in okres Martin. Filtered to the `SPOLU` breakdown on
 * purpose: the cube's NACE breakdowns OVERLAP — `B_C_D_E` repeats sections B,
 * C, D and E, which are also present individually — so anything that sums the
 * breakdown column double-counts.
 */
export async function getAverageWage(): Promise<WageYear[]> {
  const rows = await query<{ year: number; value: string }>(
    `select year, value from datacube_series
     where cube = 'np3110rr' and breakdown = 'SPOLU' and value is not null
     order by year`
  )
  return rows.map((row) => ({ year: row.year, wage: Number(row.value) }))
}

export type HousingYear = {
  year: number
  completed: number | null
  started: number | null
}

export async function getHousing(): Promise<HousingYear[]> {
  const rows = await query<{
    year: number
    completed: string | null
    started: string | null
  }>(
    `select year,
            max(value) filter (where indicator = 'DOKONC_BYT') as completed,
            max(value) filter (where indicator = 'ZAC_BYT') as started
     from datacube_series where cube = 'st3004rr'
     group by year order by year`
  )
  const num = (value: string | null) => (value === null ? null : Number(value))
  return rows.map((row) => ({
    year: row.year,
    completed: num(row.completed),
    started: num(row.started),
  }))
}

// ---------------------------------------------------------------------------
// Contracts (aggregated — no counterparty names are stored, by design)
// ---------------------------------------------------------------------------

export type ContractKind = {
  kind: string
  count: number
  total: number
  firstYear: number
  lastYear: number
}

export async function getContractKinds(limit = 12): Promise<ContractKind[]> {
  const rows = await query<{
    kind: string
    count: string
    total: string
    first_year: number
    last_year: number
  }>(
    `select kind, sum(cnt) as count, sum(amount_eur) as total,
            min(year) as first_year, max(year) as last_year
     from contract_stats group by kind order by total desc limit $1`,
    [limit]
  )
  return rows.map((row) => ({
    kind: row.kind,
    count: toNumber(row.count),
    total: toNumber(row.total),
    firstYear: row.first_year,
    lastYear: row.last_year,
  }))
}

export async function getContractTotals(): Promise<{
  total: number
  count: number
  kinds: number
} | null> {
  const [row] = await query<{ total: string; count: string; kinds: string }>(
    `select coalesce(sum(amount_eur), 0) as total, coalesce(sum(cnt), 0) as count,
            count(distinct kind) as kinds
     from contract_stats`
  )
  if (!row || toNumber(row.count) === 0) return null
  return {
    total: toNumber(row.total),
    count: toNumber(row.count),
    kinds: toNumber(row.kinds),
  }
}

export type TenderValueSummary = {
  priced: number
  total: number
  unpriced: number
}

export async function getTenderValueSummary(): Promise<TenderValueSummary> {
  const [row] = await query<{
    priced: string
    total: string
    unpriced: string
  }>(
    `select count(*) filter (where estimated_value_eur is not null) as priced,
            coalesce(sum(estimated_value_eur), 0) as total,
            count(*) filter (where value_checked_at is null) as unpriced
     from uvo_tenders`
  )
  return {
    priced: toNumber(row?.priced ?? 0),
    total: toNumber(row?.total ?? 0),
    unpriced: toNumber(row?.unpriced ?? 0),
  }
}

export type AuthorityTenders = {
  authority: string
  count: number
  total: number
}

export async function getTendersByAuthority(): Promise<AuthorityTenders[]> {
  const rows = await query<{ authority: string; count: string; total: string }>(
    `select authority, count(*) as count,
            coalesce(sum(estimated_value_eur), 0) as total
     from uvo_tenders group by authority order by count desc`
  )
  return rows.map((row) => ({
    authority: row.authority,
    count: toNumber(row.count),
    total: toNumber(row.total),
  }))
}

// ---------------------------------------------------------------------------
// Wave 5 — GIS layers
// ---------------------------------------------------------------------------

export type GisLayerMeta = {
  layer: string
  title: string
  featureCount: number
  group: string
}

export async function getGisLayers(): Promise<GisLayerMeta[]> {
  const rows = await query<{
    layer: string
    title: string
    layer_group: string
    feature_count: number
  }>(
    `select layer, title, layer_group, feature_count from gis_layers
     order by layer_group, feature_count desc`
  )
  return rows.map((row) => ({
    layer: row.layer,
    title: row.title,
    featureCount: row.feature_count,
    group: row.layer_group,
  }))
}

export type GisFeatureRow = {
  id: number
  label: string | null
  props: Record<string, string>
  geometry: unknown
}

/**
 * Features of one layer inside a viewport.
 *
 * The cap is a real limit, not a formality: the greenery layers hold 21 402 and
 * 11 039 features and shipping either whole would be several megabytes. The
 * caller is told when it bit so the map can say "zoom in" rather than quietly
 * drawing a slice.
 */
export async function getGisFeatures(
  layer: string,
  bbox: [number, number, number, number],
  limit = 2500
): Promise<{ features: GisFeatureRow[]; capped: boolean; total: number }> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const [counts] = await query<{ total: string }>(
    `select count(*) as total from gis_features
     where layer = $1 and min_lon <= $4 and max_lon >= $2
       and min_lat <= $5 and max_lat >= $3`,
    [layer, minLon, minLat, maxLon, maxLat]
  )
  const total = toNumber(counts?.total ?? 0)

  const rows = await query<{
    feature_id: string
    label: string | null
    props: Record<string, string> | null
    geometry: unknown
  }>(
    `select feature_id, label, props, geometry from gis_features
     where layer = $1 and min_lon <= $4 and max_lon >= $2
       and min_lat <= $5 and max_lat >= $3
     limit $6`,
    [layer, minLon, minLat, maxLon, maxLat, limit]
  )

  return {
    features: rows.map((row) => ({
      id: Number(row.feature_id),
      label: row.label,
      props: row.props ?? {},
      geometry: row.geometry,
    })),
    capped: total > limit,
    total,
  }
}
