import type { Pool } from "pg"

import { loadDatacubeSeries } from "./datacube"
import { upsertBatched } from "./load"
import { fetchMartinFinancials } from "./registeruz"
import { fetchUvoTenders, fetchUvoTenderValue, UVO_AUTHORITIES } from "./uvo"
import { fetchMunicipalElection } from "./volby"

/**
 * How far back to re-read filed financial statements on a routine run. Three
 * years is what catches a late amendment: Martin re-filed its 2022 consolidated
 * statement eight months after the original, with different figures.
 */
const FINANCIALS_LOOKBACK_YEARS = 3

/**
 * Tenders to price per run. Each costs about three requests to a server that
 * intermittently takes 26 s for one page, so a full 223-tender backfill is
 * ~13 minutes. Sixty a run fits the daily budget and converges in four days;
 * after that only genuinely new tenders are left.
 */
const TENDER_VALUES_PER_RUN = 60
const TENDER_VALUE_FLUSH_EVERY = 10

/** Same circuit breaker as the IČO pass, for the same reason: a dead upstream
 * must cost its own source, not the whole nightly job. */
const TENDER_FAILURES_BEFORE_GIVING_UP = 5

/**
 * Register-style sources: city financial statements, public procurement,
 * national statistics and election results.
 *
 * All four accumulate or replace only their own scope, so none of them can
 * damage the spending snapshot. They run after it, in their own transaction,
 * and a failure in one is reported without taking the others down — these are
 * four unrelated public servers and any of them can be having a bad day.
 */
export async function loadReferenceData(
  pool: Pool
): Promise<Record<string, unknown>> {
  const detail: Record<string, unknown> = {}

  detail.financials = await step("financials", () => loadFinancials(pool))
  detail.procurement = await step("procurement", () => loadProcurement(pool))
  detail.tenderValues = await step("tender values", () =>
    enrichTenderValues(pool)
  )
  detail.statistics = await step("statistics", () => loadDatacubeSeries(pool))
  detail.elections = await step("elections", () => loadElections(pool))

  return detail
}

async function step(
  name: string,
  run: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ${name} FAILED: ${message}`)
    return { failed: message }
  }
}

async function loadFinancials(pool: Pool): Promise<Record<string, unknown>> {
  const since = new Date().getFullYear() - FINANCIALS_LOOKBACK_YEARS
  console.log(`Fetching city financial statements since ${since}…`)
  const years = await fetchMartinFinancials({ since })
  console.log(`  ${years.length} statements`)

  const client = await pool.connect()
  try {
    await client.query("begin")
    await upsertBatched(
      client,
      "city_financials",
      [
        "fiscal_year",
        "consolidated",
        "statement_id",
        "filed_on",
        "prepared_on",
        "balance_template_id",
        "income_template_id",
        "total_assets_net",
        "non_current_assets",
        "current_assets",
        "equity",
        "liabilities",
        "bank_loans",
        "deferred_income",
        "total_expenses",
        "total_revenues",
        "profit_before_tax",
        "profit_after_tax",
      ],
      ["fiscal_year", "consolidated"],
      [
        "statement_id",
        "filed_on",
        "prepared_on",
        "balance_template_id",
        "income_template_id",
        "total_assets_net",
        "non_current_assets",
        "current_assets",
        "equity",
        "liabilities",
        "bank_loans",
        "deferred_income",
        "total_expenses",
        "total_revenues",
        "profit_before_tax",
        "profit_after_tax",
      ],
      years.map((year) => [
        year.fiscalYear,
        year.consolidated,
        year.statementId,
        year.filedOn,
        year.preparedOn,
        year.balanceTemplateId,
        year.incomeTemplateId,
        year.totalAssetsNet,
        year.nonCurrentAssets,
        year.currentAssets,
        year.equity,
        year.liabilities,
        year.bankLoans,
        year.deferredIncome,
        year.totalExpenses,
        year.totalRevenues,
        year.profitBeforeTax,
        year.profitAfterTax,
      ])
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }

  return { statements: years.length, since }
}

async function loadProcurement(pool: Pool): Promise<Record<string, unknown>> {
  console.log(`Fetching ÚVO tenders for ${UVO_AUTHORITIES.length} authorities…`)
  const { rows: storedRows } = await pool.query<{
    authority_ico: string
    total: number
  }>(
    "select authority_ico, count(*)::int as total from uvo_tenders group by authority_ico"
  )
  const stored = new Map(
    storedRows.map((row) => [row.authority_ico, row.total])
  )

  const tenders = []
  const perAuthority: Record<string, number> = {}
  const emptied: string[] = []
  for (const authority of UVO_AUTHORITIES) {
    const found = await fetchUvoTenders(authority.ico, authority.label)
    perAuthority[authority.label] = found.length
    tenders.push(...found)
    console.log(`  ${authority.label}: ${found.length}`)
    // ÚVO keeps a tender listed for good, so an authority falling from N to
    // zero is the listing failing, not the tenders vanishing. From 18 Sep 2026
    // the CI runner got zero for Mesto Martin (223 stored) on every run and the
    // step still reported success.
    const known = stored.get(authority.ico) ?? 0
    if (found.length === 0 && known > 0) {
      emptied.push(`${authority.label} (${known} stored)`)
    }
  }

  const client = await pool.connect()
  try {
    await client.query("begin")
    await upsertBatched(
      client,
      "uvo_tenders",
      [
        "uvo_id",
        "authority_ico",
        "authority",
        "name",
        "cpv_label",
        "nuts_label",
        "updated_on",
        "via_evo",
      ],
      ["uvo_id"],
      ["authority", "name", "cpv_label", "nuts_label", "updated_on", "via_evo"],
      tenders.map((tender) => [
        tender.uvoId,
        tender.authorityIco,
        tender.authority,
        tender.name,
        tender.cpvLabel,
        tender.nutsLabel,
        tender.updatedOn,
        tender.viaEvo,
      ])
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }

  // The authorities that did answer are stored above; the empty ones are
  // reported as a failure rather than as "0 tenders".
  if (emptied.length > 0) {
    throw new Error(`uvo listing answered 0 records for ${emptied.join(", ")}`)
  }

  // Per-tender detail (status, procedure type, CPV codes) exists in etl/uvo.ts
  // but is not wired in — it is another request per tender for fields nothing
  // on the site shows yet.
  return { tenders: tenders.length, perAuthority }
}

async function loadElections(pool: Pool): Promise<Record<string, unknown>> {
  console.log("Fetching municipal election results…")
  const election = await fetchMunicipalElection()
  console.log(
    `  ${election.turnout.length} precincts, ${election.candidates.length} candidates`
  )

  const client = await pool.connect()
  try {
    await client.query("begin")
    await upsertBatched(
      client,
      "election_turnout",
      [
        "election_year",
        "obec_code",
        "ward",
        "precinct",
        "registered",
        "voted",
        "envelopes",
        "valid_council_ballots",
        "valid_mayor_ballots",
      ],
      ["election_year", "obec_code", "ward", "precinct"],
      [
        "registered",
        "voted",
        "envelopes",
        "valid_council_ballots",
        "valid_mayor_ballots",
      ],
      election.turnout.map((row) => [
        row.electionYear,
        row.obecCode,
        row.ward,
        row.precinct,
        row.registered,
        row.voted,
        row.envelopes,
        row.validCouncilBallots,
        row.validMayorBallots,
      ])
    )
    await upsertBatched(
      client,
      "election_candidates",
      [
        "election_year",
        "obec_code",
        "office",
        "ward",
        "ballot_no",
        "first_name",
        "last_name",
        "party",
        "votes",
        "elected",
        "withdrawn",
      ],
      ["election_year", "obec_code", "office", "ward", "ballot_no"],
      ["first_name", "last_name", "party", "votes", "elected", "withdrawn"],
      election.candidates.map((row) => [
        row.electionYear,
        row.obecCode,
        row.office,
        row.ward,
        row.ballotNo,
        row.firstName,
        row.lastName,
        row.party,
        row.votes,
        row.elected,
        row.withdrawn,
      ])
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }

  return {
    year: election.electionYear,
    precincts: election.turnout.length,
    candidates: election.candidates.length,
  }
}

/**
 * Prices the tenders that have not been looked at yet, newest first, flushing
 * as it goes.
 *
 * Tenders with no published estimate are stamped too, not skipped: about 22% of
 * them carry no "predpokladaná hodnota" in any notice, and without the stamp
 * those would be re-fetched forever and the pass would never converge.
 */
async function enrichTenderValues(
  pool: Pool
): Promise<Record<string, unknown>> {
  const { rows: pending } = await pool.query<{ uvo_id: string }>(
    `select uvo_id from uvo_tenders
     where value_checked_at is null
     order by updated_on desc
     limit $1`,
    [TENDER_VALUES_PER_RUN]
  )
  const [{ remaining }] = (
    await pool.query<{ remaining: string }>(
      "select count(*) as remaining from uvo_tenders where value_checked_at is null"
    )
  ).rows

  if (pending.length === 0) return { pending: 0, priced: 0 }
  console.log(
    `Pricing ${pending.length} tenders (${remaining} unpriced in total)…`
  )

  let buffer: [number, number | null, string | null][] = []
  let priced = 0

  const flush = async () => {
    if (buffer.length === 0) return
    const client = await pool.connect()
    try {
      await client.query("begin")
      for (const [uvoId, value, code] of buffer) {
        await client.query(
          `update uvo_tenders
           set estimated_value_eur = $2, value_notice_code = $3, value_checked_at = now()
           where uvo_id = $1`,
          [uvoId, value, code]
        )
      }
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    } finally {
      client.release()
    }
    buffer = []
  }

  let consecutiveFailures = 0
  let failures = 0
  let abandoned = false

  for (const row of pending) {
    const uvoId = Number(row.uvo_id)
    try {
      const value = await fetchUvoTenderValue(uvoId)
      buffer.push([
        uvoId,
        value?.estimatedValueEur ?? null,
        value?.noticeCode ?? null,
      ])
      consecutiveFailures = 0
      if (value) priced += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  tender ${uvoId} failed: ${message}`)
      failures += 1
      consecutiveFailures += 1
      if (consecutiveFailures >= TENDER_FAILURES_BEFORE_GIVING_UP) {
        console.log(
          `  uvo: ${consecutiveFailures} failures in a row — abandoning the pricing pass`
        )
        abandoned = true
        break
      }
    }
    if (buffer.length >= TENDER_VALUE_FLUSH_EVERY) await flush()
  }
  await flush()

  console.log(`  priced ${priced} of ${pending.length}`)
  return {
    attempted: pending.length,
    priced,
    stillUnpriced: Number(remaining) - pending.length,
    // A `failed` key is what marks a step as failed in etl_runs and the run
    // summary. Without it the pass failed the same tenders daily, unseen.
    ...(failures > 0 && {
      failed:
        `${failures} of ${pending.length} tenders could not be priced` +
        (abandoned ? ", pass abandoned" : ""),
    }),
  }
}
