import {
  SOURCES,
  type RawContract,
  type RawInvoice,
  type RawOrder,
} from "./sources"
import { fetchDataset } from "./fetch"
import { loadCityData } from "./load-city"
import { loadGisLayers } from "./load-gis"
import { loadReferenceData } from "./load-reference"
import { applySchema, createPool, insertBatched } from "./load"
import { supplierKey } from "./normalize"
import {
  buildSuppliers,
  transformContracts,
  transformInvoices,
  transformOrders,
  type SpendRow,
} from "./transform"

const INVOICE_FIELDS = [
  "Číslo_faktúry",
  "Dodávateľ",
  "Predmet_faktúry",
  "Celková_cena",
  "Mena",
  "Dátum_vystavenia",
] as const

const ORDER_FIELDS = [
  "Číslo_objednávky",
  "Dodávateľ",
  "Text_objednávky",
  "Objednávka_spolu",
  "Mena",
  "Dátum_vystavenia",
] as const

const CONTRACT_FIELDS = [
  "Rok",
  "Typ",
  "Cena_celkom",
  "Mena",
  "Dátum_podpisu",
] as const

const SPEND_COLUMNS = [
  "supplier_id",
  "doc_number",
  "subject",
  "amount_eur",
  "issued_on",
  "published_on",
] as const

function toTuples(
  rows: readonly SpendRow[],
  supplierIds: Map<string, number>
): unknown[][] {
  return rows.map((row) => [
    supplierIds.get(supplierKey(row.supplierName)),
    row.docNumber,
    row.subject,
    row.amountEur,
    row.issuedOn,
    row.publishedOn,
  ])
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const pool = createPool()

  // DDL is idempotent and must exist before the run is recorded.
  await applySchema(pool)

  // A run killed mid-flight never reaches its error handler, so its row would
  // sit at 'running' forever and the log would suggest a job is still going.
  // Nothing here runs concurrently, so anything still 'running' is orphaned.
  const { rowCount: orphaned } = await pool.query(
    "update etl_runs set status = 'aborted', finished_at = now() where finished_at is null"
  )
  if (orphaned) console.log(`Marked ${orphaned} orphaned run(s) as aborted`)

  const { rows: runRows } = await pool.query<{ id: string }>(
    `insert into etl_runs (status) values ('running') returning id`
  )
  const runId = runRows[0].id

  try {
    // Fetched sequentially on purpose: this is a municipal server and the
    // orders export alone takes ~40 s of server-side generation.
    console.log("Fetching source datasets…")
    const rawInvoices = await fetchDataset<RawInvoice>(
      "invoices",
      SOURCES.invoices,
      INVOICE_FIELDS
    )
    const rawOrders = await fetchDataset<RawOrder>(
      "orders",
      SOURCES.orders,
      ORDER_FIELDS
    )
    const rawContracts = await fetchDataset<RawContract>(
      "contracts",
      SOURCES.contracts,
      CONTRACT_FIELDS
    )

    console.log("Transforming…")
    const invoices = transformInvoices(rawInvoices)
    const orders = transformOrders(rawOrders)
    const contracts = transformContracts(rawContracts)
    const suppliers = buildSuppliers([
      ...invoices.rows.map((row) => row.supplierName),
      ...orders.rows.map((row) => row.supplierName),
    ])
    console.log(
      `  invoices ${invoices.rows.length} (skipped ${invoices.skipped}), ` +
        `orders ${orders.rows.length} (skipped ${orders.skipped}), ` +
        `suppliers ${suppliers.size}, contract buckets ${contracts.rows.length}`
    )

    console.log("Loading…")
    const client = await pool.connect()
    try {
      await client.query("begin")
      await client.query(
        "truncate invoices, orders, suppliers restart identity cascade"
      )
      await client.query("truncate contract_stats")

      await insertBatched(
        client,
        "suppliers",
        ["norm_key", "display_name"],
        [...suppliers].map(([key, name]) => [key, name])
      )

      const { rows: supplierRows } = await client.query<{
        id: string
        norm_key: string
      }>("select id, norm_key from suppliers")
      const supplierIds = new Map(
        supplierRows.map((row) => [row.norm_key, Number(row.id)])
      )

      await insertBatched(
        client,
        "invoices",
        SPEND_COLUMNS,
        toTuples(invoices.rows, supplierIds)
      )
      await insertBatched(
        client,
        "orders",
        SPEND_COLUMNS,
        toTuples(orders.rows, supplierIds)
      )
      await insertBatched(
        client,
        "contract_stats",
        ["year", "kind", "cnt", "amount_eur"],
        contracts.rows.map((row) => [
          row.year,
          row.kind,
          row.cnt,
          row.amountEur,
        ])
      )

      // Search runs on `simple` + unaccent because Postgres ships no Slovak
      // stemmer; the supplier name is folded in so a name search also works.
      for (const table of ["invoices", "orders"]) {
        await client.query(
          `update ${table} t set search_vec = to_tsvector(
             'simple',
             unaccent(coalesce(t.subject, '') || ' ' || s.display_name)
           )
           from suppliers s where s.id = t.supplier_id`
        )
      }

      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    } finally {
      client.release()
    }

    const city = await loadCityData(pool)
    const reference = await loadReferenceData(pool)

    console.log("Fetching GIS layers…")
    const gis = await loadGisLayers(pool)

    const detail = {
      invoices: { loaded: invoices.rows.length, skipped: invoices.skipped },
      orders: { loaded: orders.rows.length, skipped: orders.skipped },
      contracts: { buckets: contracts.rows.length, skipped: contracts.skipped },
      suppliers: suppliers.size,
      city,
      reference,
      gis,
      durationMs: Date.now() - startedAt,
    }
    // A failed reference step has already been isolated and its error kept in
    // `detail`, but a green Actions run hid ÚVO failing for days, so the run
    // is recorded as 'partial' and exits non-zero.
    const failedSteps = Object.entries(reference)
      .filter(
        ([, value]) =>
          typeof value === "object" && value !== null && "failed" in value
      )
      .map(([name]) => name)

    await pool.query(
      `update etl_runs set status = $3, finished_at = now(), detail = $2 where id = $1`,
      [runId, detail, failedSteps.length > 0 ? "partial" : "ok"]
    )
    console.log(
      `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
        (failedSteps.length > 0 ? ` — FAILED: ${failedSteps.join(", ")}` : "")
    )
    if (failedSteps.length > 0) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pool.query(
      `update etl_runs set status = 'failed', finished_at = now(), detail = $2 where id = $1`,
      [runId, { error: message }]
    )
    throw error
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
