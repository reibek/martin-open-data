const BASE = "https://www.registeruz.sk/cruz-public/api"

const MARTIN_ICO = "00316792"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** One accounting unit, one statement, one report — nothing is hammered. */
const REQUEST_GAP_MS = 250

/** First fiscal year RÚZ holds for Mesto Martin (verified 2026-09-13). */
export const FIRST_FISCAL_YEAR = 2013

export type MartinFinancialYear = {
  fiscalYear: number
  consolidated: boolean
  statementId: number
  filedOn: string | null
  preparedOn: string | null
  balanceTemplateId: number
  incomeTemplateId: number
  totalAssetsNet: number
  nonCurrentAssets: number
  currentAssets: number
  equity: number
  liabilities: number
  bankLoans: number
  deferredIncome: number
  totalExpenses: number
  totalRevenues: number
  profitBeforeTax: number
  profitAfterTax: number
}

type Statement = {
  id: number
  obdobieOd?: string
  obdobieDo?: string
  typ?: string
  konsolidovana?: boolean
  datumPodania?: string
  datumZostavenia?: string
  idUctovnychVykazov?: number[]
}

type ReportTable = { nazov?: { sk?: string }; data?: unknown[] }

type Report = {
  id: number
  idSablony?: number
  obsah?: { tabulky?: ReportTable[] }
}

type TemplateRow = { text?: { sk?: string }; oznacenie?: string }

type TemplateTable = {
  nazov?: { sk?: string }
  riadky?: TemplateRow[]
  hlavicka?: { text?: { sk?: string }; riadok: number; stlpec: number }[]
  pocetStlpcov?: number
  pocetDatovychStlpcov?: number
}

type Template = { id: number; nazov?: string; tabulky?: TemplateTable[] }

/** Diacritics off, whitespace collapsed, lower-cased — labels drift cosmetically. */
const norm = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/**
 * RÚZ emits "182072156.12" — dot decimal, no thousands separator (verified on
 * all 26 Martin filings). The whitespace/comma handling is defensive only:
 * every other Slovak source in this project arrives as "  1 919,76". Note JS
 * \s already matches NBSP, so no separate U+00A0 class is needed.
 */
const toAmount = (raw: unknown, where: string): number => {
  if (raw === null || raw === undefined) return 0
  const text = String(raw).replace(/\s/g, "").replace(",", ".")
  if (text === "") return 0
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `registeruz: ${where} is not a number: ${JSON.stringify(raw)}`
    )
  }
  return parsed
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}/${path}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    })
  } catch (cause) {
    // A bare DOMException from AbortSignal.timeout names nothing; registeruz.sk
    // does slow to a crawl under load and a 168-request backfill will meet it.
    throw new Error(`registeruz: GET /${path} failed: ${String(cause)}`, {
      cause,
    })
  }
  if (!response.ok) {
    throw new Error(`registeruz: GET /${path} HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

/** Which data column of a template table holds the CURRENT period's figure. */
function currentPeriodColumn(table: TemplateTable, where: string): number {
  const columnCount = table.pocetStlpcov ?? 0
  const dataColumns = table.pocetDatovychStlpcov ?? 0
  if (columnCount <= 0 || dataColumns <= 0) {
    throw new Error(`registeruz: ${where} template has no data columns`)
  }

  const headerTexts = new Map<number, string[]>()
  for (const cell of table.hlavicka ?? []) {
    const texts = headerTexts.get(cell.stlpec) ?? []
    texts.push(norm(cell.text?.sk ?? ""))
    headerTexts.set(cell.stlpec, texts)
  }

  const candidates: { index: number; texts: string[] }[] = []
  for (let index = 0; index < dataColumns; index += 1) {
    const texts = headerTexts.get(columnCount - dataColumns + 1 + index) ?? []
    const isPriorPeriod = texts.some(
      (text) => text === "20xx-1" || text.includes("predchadzajuce")
    )
    if (!isPriorPeriod) candidates.push({ index, texts })
  }
  if (candidates.length === 0) {
    throw new Error(
      `registeruz: ${where} — every data column reads as a prior period, header changed`
    )
  }

  for (const wanted of ["spolu", "netto"]) {
    const hit = candidates.find((column) => column.texts.includes(wanted))
    if (hit) return hit.index
  }
  return candidates[0].index
}

type RowSpec = { table: number; code: string | null; stem: string }

/**
 * Row addresses are (table, oznacenie, label stem) — NOT row indexes and NOT
 * `cisloRiadku`. The four balance-sheet templates Martin has filed have 114,
 * 115, 117 and 118 asset rows and the same figure sits on a different line in
 * each, so an index copied from one template silently reads a neighbouring line
 * in the next. Verified: every stem below matches exactly one row in each of
 * sablona 690, 684, 522, 11 (balance) and 727, 696, 521, 12 (income).
 */
const BALANCE_ROWS = {
  totalAssetsNet: { table: 0, code: null, stem: "spolu majetok" },
  nonCurrentAssets: { table: 0, code: "A.", stem: "neobezny majetok" },
  currentAssets: { table: 0, code: "B.", stem: "obezny majetok" },
  equityAndLiabilities: {
    table: 1,
    code: null,
    stem: "vlastne imanie a zavazky",
  },
  equity: { table: 1, code: "A.", stem: "vlastne imanie" },
  liabilities: { table: 1, code: "B.", stem: "zavazky sucet" },
  bankLoans: { table: 1, code: "B.V.", stem: "bankove uvery a vypomoci" },
  deferredIncome: { table: 1, code: "C.", stem: "casove rozlisenie" },
  treasuryRelations: { table: 1, code: "D.", stem: "vztahy k uctom klientov" },
} satisfies Record<string, RowSpec>

const INCOME_ROWS = {
  totalExpenses: { table: 0, code: null, stem: "uctove skupiny 50 - 58" },
  totalRevenues: { table: 1, code: null, stem: "uctova trieda 6" },
  profitBeforeTax: {
    table: 1,
    code: null,
    stem: "vysledok hospodarenia pred zdanenim",
  },
  profitAfterTax: {
    table: 1,
    code: null,
    stem: "vysledok hospodarenia po zdaneni",
  },
} satisfies Record<string, RowSpec>

function readRows<K extends string>(
  report: Report,
  template: Template,
  specs: Record<K, RowSpec>
): Record<K, number> {
  const templateId = report.idSablony
  const reportTables = report.obsah?.tabulky
  const templateTables = template.tabulky
  if (!Array.isArray(reportTables) || !Array.isArray(templateTables)) {
    throw new Error(
      `registeruz: report ${report.id} / template ${templateId} has no tabulky`
    )
  }

  const out = {} as Record<K, number>
  for (const key of Object.keys(specs) as K[]) {
    const spec = specs[key]
    const templateTable = templateTables[spec.table]
    const reportTable = reportTables[spec.table]
    const rows = templateTable?.riadky
    const cells = reportTable?.data
    if (!Array.isArray(rows) || !Array.isArray(cells)) {
      throw new Error(
        `registeruz: template ${templateId} table ${spec.table} missing riadky/data`
      )
    }

    const dataColumns = templateTable?.pocetDatovychStlpcov ?? 0
    if (cells.length !== rows.length * dataColumns) {
      throw new Error(
        `registeruz: report ${report.id} table ${spec.table} has ${cells.length} cells, ` +
          `template ${templateId} describes ${rows.length}×${dataColumns}`
      )
    }

    const matches: number[] = []
    rows.forEach((row, index) => {
      const code = (row.oznacenie ?? "").trim()
      if (spec.code === null ? code !== "" : code !== spec.code) return
      if (!norm(row.text?.sk ?? "").startsWith(spec.stem)) return
      matches.push(index)
    })
    if (matches.length !== 1) {
      throw new Error(
        `registeruz: template ${templateId} table ${spec.table} matched ${matches.length} ` +
          `rows for "${spec.code ?? "-"} ${spec.stem}" — the ministry changed the form`
      )
    }

    const column = currentPeriodColumn(
      templateTable as TemplateTable,
      `template ${templateId} table ${spec.table}`
    )
    out[key] = toAmount(
      cells[matches[0] * dataColumns + column],
      `template ${templateId} row ${matches[0]} col ${column}`
    )
  }
  return out
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.02

/**
 * Mesto Martin's own filed financial statements from the Ministry of Finance
 * register (RÚZ Open API v2.5, unauthenticated). The chain is
 * uctovne-jednotky?ico= → uctovna-jednotka → uctovna-zavierka → uctovny-vykaz →
 * sablona, and the trap is the last hop: the city files TWO statements per year
 * and they use DIFFERENT form templates. The individual filing uses sablona 690
 * (súvaha) + 727 (VZaS) since 2014 and 522 + 521 for 2013; the consolidated one
 * uses 684 + 696 since 2014 and 11 + 12 for 2013. Those templates disagree on
 * both row count (114 / 115 / 117 / 118 asset rows) and column layout —
 * individual assets carry Brutto/Korekcia/Netto/prior-Netto, consolidated assets
 * carry only Netto/prior-Netto — so a row index or a data-column index lifted
 * from one template reads a different line, or the gross figure instead of the
 * net one, in another. Every figure here is therefore addressed by (table,
 * oznacenie, label stem) inside the sablona the report itself declares, and the
 * column is derived from that sablona's header. The prior-period column is
 * spelled "20xx-1" on the 2014 forms and "Bezprostredne predchádzajúce účtovné
 * obdobie" on the 2012 ones, so both spellings are excluded.
 *
 * Three accounting identities are asserted per filing, which is what actually
 * proves the mapping landed on the right lines; all 26 filings pass.
 *
 * Dates stay plain "YYYY-MM-DD" strings — never Date objects, the table columns
 * are Postgres `date`. RÚZ publishes no wall-clock times at all. The two 2013
 * statements carry NO datumPodania and NO datumZostavenia, so filed_on and
 * prepared_on must stay nullable.
 *
 * Privacy: uctovne-jednotky?ico= is NOT a personal-data-free endpoint — probing
 * ico=00000000 returns 37 units and uctovna-jednotka?id=821886 is a named
 * natural person with a home address (pravnaForma 105). This fetcher resolves
 * exactly one IČO, 00316792, a municipality (pravnaForma 801), and stores only
 * aggregate figures. It never enumerates units and never downloads `prilohy`.
 *
 * Cost: a full backfill is 168 sequential GETs and took 168 s on 2026-09-13
 * (measured; 26 rows). `{ since: 2023 }` is 66 GETs / 118 s — the 27 statement
 * records are always fetched before the year filter can apply, only the report
 * and template hops are skipped. Run the backfill weekly; a daily pipeline
 * should pass `{ since: new Date().getFullYear() - 3 }`, which still catches a
 * late amendment (the 2022 consolidated re-filing landed in November 2023).
 */
export async function fetchMartinFinancials(
  options: { since?: number } = {}
): Promise<MartinFinancialYear[]> {
  const since = options.since ?? FIRST_FISCAL_YEAR

  const units = await getJson<{ id?: number[] }>(
    `uctovne-jednotky?zmenene-od=2000-01-01&ico=${MARTIN_ICO}`
  )
  if (!Array.isArray(units.id) || units.id.length === 0) {
    throw new Error(
      `registeruz: no accounting unit for IČO ${MARTIN_ICO}, source schema changed`
    )
  }
  if (units.id.length > 1) {
    throw new Error(
      `registeruz: IČO ${MARTIN_ICO} now resolves to ${units.id.length} units (${units.id.join(", ")})`
    )
  }
  const unitId = units.id[0]

  await sleep(REQUEST_GAP_MS)
  const unit = await getJson<{
    nazovUJ?: string
    ico?: string
    idUctovnychZavierok?: number[]
  }>(`uctovna-jednotka?id=${unitId}`)
  if (unit.ico !== MARTIN_ICO) {
    throw new Error(
      `registeruz: unit ${unitId} reports IČO ${unit.ico}, expected ${MARTIN_ICO}`
    )
  }
  const statementIds = unit.idUctovnychZavierok
  if (!Array.isArray(statementIds) || statementIds.length === 0) {
    throw new Error(`registeruz: unit ${unitId} lists no idUctovnychZavierok`)
  }

  const statements: Statement[] = []
  for (const id of statementIds) {
    await sleep(REQUEST_GAP_MS)
    statements.push(await getJson<Statement>(`uctovna-zavierka?id=${id}`))
  }

  // One row per (fiscal year, individual|consolidated). Martin has re-filed a
  // year before — the 2022 consolidated statement exists twice, id 5600072
  // filed 2023-06-21 (total assets 182 072 156.12, PAT 1 594 128.65) and id
  // 5712071 filed 2023-11-23 (180 703 168.33, 1 566 593.89) — so the later
  // filing wins and the earlier one is dropped before it can collide on the
  // natural key. The 2013 pair has no datumPodania at all, so the tie-break
  // falls through to the statement id.
  const chosen = new Map<string, Statement>()
  for (const statement of statements) {
    if ((statement.typ ?? "") !== "Riadna") continue
    const from = statement.obdobieOd ?? ""
    const to = statement.obdobieDo ?? ""
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      throw new Error(
        `registeruz: statement ${statement.id} has unparseable period ${from}..${to}`
      )
    }
    if (
      from.slice(0, 4) !== to.slice(0, 4) ||
      from.slice(5) !== "01" ||
      to.slice(5) !== "12"
    ) {
      throw new Error(
        `registeruz: statement ${statement.id} covers ${from}..${to}, not a calendar year`
      )
    }
    const fiscalYear = Number(from.slice(0, 4))
    if (fiscalYear < since) continue

    const key = `${fiscalYear}|${statement.konsolidovana === true}`
    const held = chosen.get(key)
    const newer =
      !held ||
      (statement.datumPodania ?? "") > (held.datumPodania ?? "") ||
      ((statement.datumPodania ?? "") === (held.datumPodania ?? "") &&
        statement.id > held.id)
    if (newer) chosen.set(key, statement)
  }
  if (chosen.size === 0) {
    throw new Error(
      `registeruz: unit ${unitId} has ${statements.length} statements but none since ${since}`
    )
  }

  const out: MartinFinancialYear[] = []
  const templates = new Map<number, Template>()

  for (const statement of [...chosen.values()].sort((a, b) =>
    (a.obdobieOd ?? "").localeCompare(b.obdobieOd ?? "")
  )) {
    const reportIds = statement.idUctovnychVykazov
    if (!Array.isArray(reportIds) || reportIds.length === 0) {
      throw new Error(
        `registeruz: statement ${statement.id} lists no idUctovnychVykazov`
      )
    }

    let balance: Report | null = null
    let income: Report | null = null
    for (const reportId of reportIds) {
      await sleep(REQUEST_GAP_MS)
      const report = await getJson<Report>(`uctovny-vykaz?id=${reportId}`)
      // Poznamky, sprava auditora and the titulna strana carry no tabulky, so
      // they fall through here by shape rather than by a hard-coded id.
      const first = norm(report.obsah?.tabulky?.[0]?.nazov?.sk ?? "")
      if (first === "strana aktiv") {
        if (balance) {
          throw new Error(
            `registeruz: statement ${statement.id} has two suvaha reports ` +
              `(${balance.id}, ${report.id}) — cannot tell which one is current`
          )
        }
        balance = report
      } else if (first === "naklady") {
        if (income) {
          throw new Error(
            `registeruz: statement ${statement.id} has two VZaS reports ` +
              `(${income.id}, ${report.id}) — cannot tell which one is current`
          )
        }
        income = report
      }
    }
    if (!balance || !income) {
      throw new Error(
        `registeruz: statement ${statement.id} is missing a ` +
          `${!balance ? "súvaha" : "výkaz ziskov a strát"} among reports ${reportIds.join(", ")}`
      )
    }

    for (const report of [balance, income]) {
      const templateId = report.idSablony
      if (typeof templateId !== "number") {
        throw new Error(`registeruz: report ${report.id} has no idSablony`)
      }
      if (!templates.has(templateId)) {
        await sleep(REQUEST_GAP_MS)
        templates.set(
          templateId,
          await getJson<Template>(`sablona?id=${templateId}`)
        )
      }
    }

    const b = readRows(
      balance,
      templates.get(balance.idSablony as number)!,
      BALANCE_ROWS
    )
    const i = readRows(
      income,
      templates.get(income.idSablony as number)!,
      INCOME_ROWS
    )

    const fiscalYear = Number((statement.obdobieOd ?? "").slice(0, 4))
    const label = `${fiscalYear} ${statement.konsolidovana === true ? "consolidated" : "individual"}`

    if (!near(b.totalAssetsNet, b.equityAndLiabilities)) {
      throw new Error(
        `registeruz: ${label} assets ${b.totalAssetsNet} ≠ equity+liabilities ` +
          `${b.equityAndLiabilities} — wrong row or wrong data column`
      )
    }
    const sides =
      b.equity + b.liabilities + b.deferredIncome + b.treasuryRelations
    if (!near(b.totalAssetsNet, sides)) {
      throw new Error(
        `registeruz: ${label} A+B+C+D ${sides} ≠ total ${b.totalAssetsNet} — row mapping drifted`
      )
    }
    if (!near(i.totalRevenues - i.totalExpenses, i.profitBeforeTax)) {
      throw new Error(
        `registeruz: ${label} revenues ${i.totalRevenues} − expenses ${i.totalExpenses} ` +
          `≠ pre-tax result ${i.profitBeforeTax} — row mapping drifted`
      )
    }

    out.push({
      fiscalYear,
      consolidated: statement.konsolidovana === true,
      statementId: statement.id,
      filedOn: statement.datumPodania ?? null,
      preparedOn: statement.datumZostavenia ?? null,
      balanceTemplateId: balance.idSablony as number,
      incomeTemplateId: income.idSablony as number,
      totalAssetsNet: b.totalAssetsNet,
      nonCurrentAssets: b.nonCurrentAssets,
      currentAssets: b.currentAssets,
      equity: b.equity,
      liabilities: b.liabilities,
      bankLoans: b.bankLoans,
      deferredIncome: b.deferredIncome,
      totalExpenses: i.totalExpenses,
      totalRevenues: i.totalRevenues,
      profitBeforeTax: i.profitBeforeTax,
      profitAfterTax: i.profitAfterTax,
    })
  }

  return out
}
