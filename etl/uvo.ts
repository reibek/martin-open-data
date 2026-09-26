import { parseAmount, parseDate } from "./normalize"

const BASE = "https://www.uvo.gov.sk"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** Mesto Martin needs 12 pages of 20; the guard only stops a pagination bug. */
const MAX_PAGES = 60

/** Measured 2026-09-13: 1–6 notices per tender across a 10-tender sample. */
const MAX_NOTICES_PER_TENDER = 12

/** Sequential requests with a pause — ÚVO is a small public server. */
const REQUEST_DELAY_MS = 1_200

/**
 * Measured 2026-09-13 over a 12-page sweep: ÚVO answered individual listing
 * pages in 0.4 s, 7 s and once 33.4 s, and an earlier sweep lost a page to a
 * hard timeout outright. A backfill is ~1000 sequential loads, so a single slow
 * page must not kill the run: three attempts with a widening pause.
 */
const REQUEST_TIMEOUT_MS = 120_000
const REQUEST_ATTEMPTS = 3

/** A 200-dressed dead route. Never worth retrying. */
class UvoRouteGoneError extends Error {}

const LISTING_COLUMNS = [
  "Názov zákazky",
  "Názov obstarávateľa",
  "Hlavné CPV",
  "Hlavné NUTS",
  "Aktualizácia",
] as const

/**
 * Contracting authorities worth crawling, verified by IČO against the ÚVO
 * search on 2026-09-13 (tender counts in the comments).
 *
 * Brantner Fatra and STEFE Martin were checked and dropped: neither appears as
 * a contracting authority at all — `obstarNazov=Brantner` returns 0 records and
 * `obstarNazov=STEFE` returns only the Banská Bystrica and Trnava companies.
 * Turčianska vodárenská is a regional utility owned by many municipalities, so
 * its tenders are only partly Martin's money — kept, but flag it in the UI.
 */
export const UVO_AUTHORITIES = [
  { ico: "00316792", label: "Mesto Martin" }, // 223
  { ico: "53560922", label: "Dopravný podnik mesta Martin, s. r. o." }, // 9
  { ico: "36387959", label: "Martinská parkovacia spoločnosť, a.s." }, // 10
  { ico: "36672084", label: "Turčianska vodárenská spoločnosť, a.s." }, // 10
] as const

export type UvoTender = {
  uvoId: number
  authorityIco: string
  name: string
  authority: string
  cpvLabel: string | null
  nutsLabel: string | null
  /** "Aktualizácia" — last-touched, so it MOVES. Plain "YYYY-MM-DD". */
  updatedOn: string
  viaEvo: boolean
}

export type UvoTenderDetail = {
  uvoId: number
  status: string | null
  kind: string | null
  procedure: string | null
  cpvCodes: string[]
  nutsCodes: string[]
  euFunded: boolean | null
  eAuction: boolean | null
  /** Naive local wall clock, "YYYY-MM-DD HH:MM:00" — no zone in the source. */
  createdAt: string | null
  publishedAt: string | null
}

export type UvoNotice = {
  uvoId: number
  noticeId: number
  /** Bulletin form code, e.g. "11316 - WYP". The suffix is the form type. */
  code: string | null
  kind: string | null
  publishedOn: string | null
  bulletin: string | null
}

export type UvoTenderValue = {
  uvoId: number
  noticeId: number
  estimatedValueEur: number
  /** Notices are walked oldest-first; this is the first one carrying a value. */
  noticeCode: string | null
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  times: "×",
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole)
}

/**
 * Every tag becomes a newline, not an empty string. The legacy Vestník forms
 * write `<div>Hodnota <span>50 000,0000</span><span>EUR</span></div>`, so
 * dropping tags outright would glue the label to the number and the number to
 * the currency; one line per element keeps every field addressable.
 */
function toText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, "\n"))
}

function clean(fragment: string): string {
  return toText(fragment)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\r?\n\s*/g, "\n")
    .trim()
}

function lines(fragment: string): string[] {
  return clean(fragment)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

function firstLine(fragment: string): string | null {
  return lines(fragment)[0] ?? null
}

function yesNo(fragment: string): boolean | null {
  const value = firstLine(fragment)?.toLowerCase()
  if (value === "áno") return true
  if (value === "nie") return false
  return null
}

/**
 * "05.08.2026 07:55" carries no zone, and the CI runner is UTC. Parsing it with
 * `new Date()` would shift it two hours; the naive string goes to Postgres and
 * is converted there with `set local time zone 'Europe/Bratislava'`.
 */
function parseNaiveTimestamp(raw: string | null): string | null {
  if (!raw) return null
  const match = raw
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const [, day, month, year, hour, minute, second] = match
  return `${year}-${month}-${day} ${hour}:${minute}:${second ?? "00"}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * TYPO3 answers a dead route with HTTP **200** and a stub whose only tell is
 * `<title>Nedostupne</title>`, so the status code alone proves nothing.
 */
async function fetchHtml(label: string, path: string): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(
          `uvo ${label}: HTTP ${response.status} ${response.statusText}`
        )
      }
      const body = await response.text()
      if (body.includes("<title>Nedostupne</title>")) {
        // A dead route is not transient — do not spend the remaining attempts.
        throw new UvoRouteGoneError(
          `uvo ${label}: route gone (200 + "Nedostupne" stub) — ${path}`
        )
      }
      return body
    } catch (error) {
      if (error instanceof UvoRouteGoneError) throw error
      lastError = error
      if (attempt < REQUEST_ATTEMPTS)
        await sleep(REQUEST_DELAY_MS * attempt * 2)
    }
  }
  throw new Error(
    `uvo ${label}: failed after ${REQUEST_ATTEMPTS} attempts — ${String(lastError)}`
  )
}

/**
 * Returns whole `<tr …>…</tr>` matches, opening tag included. The notices tab
 * puts the only link to a notice in `<tr onclick="…/detail/1412931…">`, so a
 * row reduced to its inner HTML loses the id entirely.
 */
function parsePageRows(html: string): string[] {
  const table = html.match(/<table id="lists-table"[\s\S]*?<\/table>/)?.[0]
  return table ? rowsOf(table) : []
}

function rowsOf(table: string): string[] {
  const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)
  if (!body) return []
  return [...body[1].matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(
    (match) => match[0]
  )
}

function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
    (match) => match[1]
  )
}

const NO_RECORDS =
  "Nenašli sa žiadne záznamy vyhovujúce zadaným vyhľadávacím kritériám."

/**
 * `<div class="pag-info"><span class="red">223 záznamov</span></div>`.
 *
 * An empty result set renders the SAME block with the number missing entirely
 * — literally `<span class="red">\n\n záznamov</span>` (verified on
 * `obstarIco=31578861`). A digit-or-space character class therefore matches the
 * whitespace, `Number("")` is 0, and a genuine markup change would be
 * indistinguishable from "no records". The digits are required here and the
 * empty case is recognised by its own sentence instead, so a redesign throws.
 */
function totalRecords(page: string): number | null {
  const match = page.match(
    /class="pag-info"[\s\S]{0,400}?<span class="red">\s*(\d[\d  ]*?)\s*záznamov/
  )
  if (match) {
    const value = Number(match[1].replace(/[\s ]/g, ""))
    return Number.isFinite(value) ? value : null
  }
  if (page.includes(NO_RECORDS)) return 0
  // The counter block present but its NUMBER missing — literally
  // `<span class="red">\n\n záznamov</span>` — is how an empty result set
  // renders on the notices tab, which unlike the search results carries no
  // "Nenašli sa žiadne záznamy" message. That is zero records, not broken
  // markup. Reading it as broken made the pricing pass throw on every tender
  // with no notices, and because a throw leaves value_checked_at null those
  // tenders would have been re-fetched on every run, forever.
  if (
    /class="pag-info"[\s\S]{0,400}?<span class="red">\s*záznamov/.test(page)
  ) {
    return 0
  }
  return null
}

/**
 * The search listing for one contracting authority, all pages.
 *
 * Two things on this endpoint are counter-intuitive. First, the pagination
 * parameter that works is `page`; the form field the page itself renders is
 * `pageNo`, and `pageNo=2` is SILENTLY IGNORED — it returns page 1 with HTTP
 * 200 (verified 2026-09-13, same trap as the sibling "profily" search). Past
 * the last page `page=13` and `page=99` both return 200 with no table at all.
 * Second, the listing carries NO price: the only money anywhere in ÚVO's tender
 * record is the estimate inside the linked Vestník notice, two hops away — see
 * `fetchUvoTenderValue`. The default ordering is by `datumAktualizacie` DESC,
 * i.e. by a MUTABLE field, so a tender updated mid-crawl shifts the window and
 * one row can be missed; the advertised total is checked against what was
 * actually collected and the run fails rather than silently under-reporting.
 *
 * Do NOT try to stabilise that by adding `&sort=nazovZakazky&sort-dir=ASC`.
 * Re-measured 2026-09-13: the sorted sweep does NOT break outright — all 12
 * pages return (20/20/…/20/3 rows, counter intact at 223) — but it is not a
 * stable ordering. The sweep yielded 223 rows of which only 222 were unique:
 * id 428109 came back twice and id 424479 was never returned at all. A sort
 * therefore silently loses a tender, which is exactly what it was meant to
 * prevent. The unsorted default returned all 223 unique ids.
 *
 * This is HTML scraping. A site redesign breaks it, deliberately loudly: the
 * header labels are asserted before any row is read.
 */
export async function fetchUvoTenders(
  ico: string,
  authorityLabel?: string
): Promise<UvoTender[]> {
  const label = authorityLabel ?? ico
  const tenders = new Map<number, UvoTender>()

  const listUrl = (page: number) =>
    `/vyhladavanie/vyhladavanie-zakaziek?obstarIco=${encodeURIComponent(ico)}&page=${page}`

  const first = await fetchHtml(`tenders ${label} p1`, listUrl(1))
  const expected = totalRecords(first)
  if (expected === null) {
    throw new Error(
      `uvo tenders ${label}: no "N záznamov" counter — pagination markup changed`
    )
  }
  if (expected === 0) {
    // Logged because ÚVO answers this "no records" page in bursts for
    // authorities that do have tenders — seen from CI daily since 18 Sep 2026
    // and locally on 26 Sep, while the same URL answered normally minutes later.
    const title = first.match(/<title>([^<]*)<\/title>/)?.[1]?.trim()
    console.log(
      `  uvo tenders ${label}: listing reports 0 records ` +
        `(${first.length} B, title "${title ?? "?"}", ` +
        `${first.includes(NO_RECORDS) ? "no-records message" : "empty counter"})`
    )
    return []
  }
  assertListingHeader(first, label)

  // The page count is derived from the advertised total and the size of page
  // one, rather than by walking until a page comes back empty. ÚVO answers
  // individual pages in anything from 0.4 s to 26 s, and a transient empty
  // response is indistinguishable from the end of the results — treating it as
  // the end silently truncated the sweep to the first few pages.
  const firstTable = first.match(
    /<table id="lists-table"[\s\S]*?<\/table>/
  )?.[0]
  const firstRows = firstTable ? rowsOf(firstTable) : []
  if (firstRows.length === 0) {
    throw new Error(
      `uvo tenders ${label}: page 1 has no rows but ${expected} advertised`
    )
  }
  const pageSize = firstRows.length
  const lastPage = Math.ceil(expected / pageSize)
  if (lastPage > MAX_PAGES) {
    throw new Error(
      `uvo tenders ${label}: ${expected} records would need ${lastPage} pages, over the ${MAX_PAGES} cap`
    )
  }

  let html = first
  for (let page = 1; page <= lastPage; page += 1) {
    if (page > 1) {
      await sleep(REQUEST_DELAY_MS)
      html = await fetchHtml(`tenders ${label} p${page}`, listUrl(page))
    }
    let pageRows = parsePageRows(html)
    // A 200 with no results table is transient — ÚVO does it under load, and the
    // same page answers normally moments later. It is NOT the end of the
    // results, which is why the page count comes from the record total.
    for (
      let retry = 1;
      pageRows.length === 0 && retry < REQUEST_ATTEMPTS;
      retry += 1
    ) {
      await sleep(REQUEST_DELAY_MS * retry * 3)
      html = await fetchHtml(
        `tenders ${label} p${page} retry ${retry}`,
        listUrl(page)
      )
      pageRows = parsePageRows(html)
    }
    if (pageRows.length === 0) {
      throw new Error(
        `uvo tenders ${label}: page ${page} of ${lastPage} still had no results table after ${REQUEST_ATTEMPTS} tries`
      )
    }
    for (const row of pageRows) {
      const tender = parseTenderRow(row, ico, label)
      tenders.set(tender.uvoId, tender)
    }
  }

  if (tenders.size !== expected) {
    throw new Error(
      `uvo tenders ${label}: collected ${tenders.size} of ${expected} advertised records`
    )
  }
  return [...tenders.values()]
}

function assertListingHeader(html: string, label: string): void {
  const head = html.match(/<thead>([\s\S]*?)<\/thead>/)
  if (!head)
    throw new Error(`uvo tenders ${label}: results table has no <thead>`)
  const headers = [...head[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
    (match) => clean(match[1])
  )
  LISTING_COLUMNS.forEach((expectedLabel, index) => {
    if (headers[index] !== expectedLabel) {
      throw new Error(
        `uvo tenders ${label}: column ${index} is "${headers[index] ?? "—"}", expected "${expectedLabel}" — listing markup changed`
      )
    }
  })
}

function parseTenderRow(row: string, ico: string, label: string): UvoTender {
  const cells = cellsOf(row)
  if (cells.length < LISTING_COLUMNS.length) {
    throw new Error(
      `uvo tenders ${label}: row has ${cells.length} cells, expected at least ${LISTING_COLUMNS.length}`
    )
  }
  const idMatch = cells[0].match(/vyhladavanie-zakaziek\/detail\/(\d+)/)
  const name = firstLine(cells[0])
  const updatedOn = parseDate(firstLine(cells[4]))
  if (!idMatch || !name || !updatedOn) {
    throw new Error(
      `uvo tenders ${label}: unparsable row (id=${idMatch?.[1] ?? "—"} name=${name ?? "—"} date=${firstLine(cells[4]) ?? "—"})`
    )
  }
  return {
    uvoId: Number(idMatch[1]),
    authorityIco: ico,
    name,
    authority: firstLine(cells[1]) ?? label,
    cpvLabel: firstLine(cells[2]),
    nutsLabel: firstLine(cells[3]),
    updatedOn,
    viaEvo: /action-evo|label-evo/.test(row),
  }
}

/**
 * The detail page is a flat `<th>label</th><td>value</td>` table. It adds the
 * machine-readable CPV and NUTS **codes** the listing drops, the procedure
 * type and the creation timestamp — but still no price.
 */
export async function fetchUvoTenderDetail(
  uvoId: number
): Promise<UvoTenderDetail> {
  const html = await fetchHtml(
    `detail ${uvoId}`,
    `/vyhladavanie/vyhladavanie-zakaziek/detail/${uvoId}`
  )
  const fields = new Map<string, string>()
  for (const match of html.matchAll(
    /<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g
  )) {
    fields.set(clean(match[1]), match[2])
  }
  for (const required of ["Dátum poslednej aktualizácie:", "Stav zákazky:"]) {
    if (!fields.has(required)) {
      throw new Error(
        `uvo detail ${uvoId}: field "${required}" gone — detail markup changed`
      )
    }
  }

  const codes = (raw: string | undefined) =>
    raw
      ? lines(raw).flatMap((line) => line.match(/^([A-Z0-9-]+)\s/)?.[1] ?? [])
      : []

  return {
    uvoId,
    status: firstLine(fields.get("Stav zákazky:") ?? ""),
    kind: firstLine(fields.get("Druh zákazky:") ?? ""),
    procedure: firstLine(fields.get("Druh postupu:") ?? ""),
    cpvCodes: codes(fields.get("CPV zákazky:")),
    nutsCodes: codes(fields.get("NUTS zákazky:")),
    euFunded: yesNo(fields.get("Spolufinancovanie z fondov EÚ:") ?? ""),
    eAuction: yesNo(fields.get("Elektronická aukcia:") ?? ""),
    createdAt: parseNaiveTimestamp(
      firstLine(fields.get("Dátum vytvorenia:") ?? "")
    ),
    publishedAt: parseNaiveTimestamp(
      firstLine(fields.get("Dátum zverejnenia:") ?? "")
    ),
  }
}

/** The "Oznámenia" tab: the Vestník notices published for one tender. */
export async function fetchUvoNotices(uvoId: number): Promise<UvoNotice[]> {
  const html = await fetchHtml(
    `notices ${uvoId}`,
    `/vyhladavanie/vyhladavanie-zakaziek/oznamenia/${uvoId}`
  )
  const expected = totalRecords(html)
  if (expected === null) {
    throw new Error(
      `uvo notices ${uvoId}: no "N záznamov" counter — notices tab markup changed`
    )
  }
  if (expected === 0) return []
  const table = html.match(/<table id="lists-table"[\s\S]*?<\/table>/)?.[0]
  if (!table) {
    throw new Error(
      `uvo notices ${uvoId}: ${expected} records advertised but no results table`
    )
  }

  const rows = rowsOf(table)
  const notices: UvoNotice[] = []
  for (const row of rows) {
    const idMatch = row.match(/vestnik\/oznamenie\/detail\/(\d+)/)
    if (!idMatch) continue
    const cells = cellsOf(row)
    // The first cell packs three values: "code<br><strong>authority</strong>
    // <span class="block">kind</span>". Splitting on <br> alone would glue the
    // authority and the kind together, so the kind is taken from its span.
    const code = clean(cells[0]?.split(/<br\s*\/?>/i)[0] ?? "") || null
    const kind =
      clean(
        cells[0]?.match(/<span class="block">([\s\S]*?)<\/span>/)?.[1] ?? ""
      ) || null
    notices.push({
      uvoId,
      noticeId: Number(idMatch[1]),
      code,
      kind,
      publishedOn: parseDate(firstLine(cells[1] ?? "")),
      bulletin: firstLine(cells[2] ?? ""),
    })
  }
  // A silent zero here looks exactly like "this tender has no notices", and
  // with it the tender silently loses its only price. Fail instead. (The tab
  // paginates at 20 like the tender search; the busiest Martin tender seen has
  // 6 notices, so only the first page is read and `expected` may exceed it.)
  if (notices.length !== rows.length) {
    throw new Error(
      `uvo notices ${uvoId}: parsed ${notices.length} of ${rows.length} rows (${expected} advertised) — notices tab markup changed`
    )
  }
  return notices
}

/** eForms, 2023+: "Predpokladaná hodnota (BT-27-Procedure) (hodnota): 1 526 605.10" */
const EFORMS_VALUE =
  /Predpokladaná hodnota \(BT-27-[A-Za-z]+\) \(hodnota\):[  ]*(\d[\d ., ]*)/

/**
 * All three pre-eForms layouts at once: a "[Celková] predpokladaná hodnota"
 * label, then OPTIONALLY a "Hodnota…" row (bare "Hodnota" in form č. 9, or
 * "Hodnota bez DPH:" in the 2017-era EU form), then the number, then
 * OPTIONALLY a "Mena:" row, then the currency.
 *
 * The "Hodnota bez DPH: … / Mena: … / EUR" variant is the one that was missing:
 * notice 346881 (tender 404300, Vestník 2017) publishes its estimate that way
 * and the earlier two-layout regex returned null for it, silently dropping the
 * only price the tender has.
 */
const LEGACY_VALUE =
  /[Pp]redpokladaná hodnota[^\n]*\n(?:Hodnota[^\n]*\n)?(\d[\d ., ]*)\n(?:Mena:[^\n]*\n)?(?:EUR|Euro)\b/

/**
 * The estimated value out of one Vestník notice — the only place in ÚVO where
 * a tender carries money, and it arrives in FOUR incompatible layouts.
 *
 * 1. Form č. 9 (up to ~2016) prints "Predpokladaná hodnota zákazky bez DPH",
 *    then a separate "Hodnota" row holding a Slovak number with FOUR decimals
 *    and a comma ("50 000,0000"), then the currency. (notice 292005)
 * 2. The 2017-era EU form prints "Celková predpokladaná hodnota", then
 *    "Hodnota bez DPH:", the number, a "Mena:" row, and only then the
 *    currency. (notice 346881)
 * 3. The later EU form (~2020) drops both extra rows and puts the number on
 *    the very next line after the label ("2 398 341,26"). (notice 442259)
 * 4. eForms (2023+) print one line, "Predpokladaná hodnota (BT-27-Procedure)
 *    (hodnota): 1 526 605.10", with a space thousands separator and a DOT
 *    decimal. (notice 1412931)
 *
 * All four are handled, verified against those four notice bodies. Layout 2
 * is the one an earlier version missed: it returned null and silently dropped
 * the only price tender 404300 has.
 *
 * The trap: a result notice also has a bare "Hodnota" row under "Informácie o
 * hodnote zmluvy" — that is the CONTRACTED price, not the estimate, and a
 * regex anchored on "Hodnota" alone silently returns the wrong number. Both
 * patterns are anchored on the "predpokladaná hodnota" label instead, and the
 * legacy one additionally requires the currency line to follow the number.
 *
 * Correction forms (…- IOX), prior-information notices (…- POS), market
 * consultations (…- POT) and several nadlimit announcement forms legitimately
 * carry no estimate at all and return null. Measured on an 18-tender sample
 * spread across 2016-2026: 14 yielded a value (78%). The four that did not
 * were verified by hand against the raw notice bodies (346881 aside, which was
 * the parser bug above) — tenders 429364, 429258, 472474 and 514355 have no
 * "predpokladaná hodnota" block in any of their notices.
 *
 * PRIVACY: this page is the one place in the whole source that carries personal
 * data — "Kontaktná osoba: Ing. …", a mobile number, a named officer's e-mail
 * and, in result forms, the winning bidder, who may be a sole trader. Only the
 * number is taken out of it; nothing else from this page is returned, let alone
 * stored.
 */
export async function fetchUvoNoticeValue(
  noticeId: number
): Promise<number | null> {
  const html = await fetchHtml(
    `notice ${noticeId}`,
    `/vestnik-a-registre/vestnik/oznamenie/detail/${noticeId}`
  )
  const text = clean(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ""))
  if (!/Vestník č\./.test(text)) {
    throw new Error(
      `uvo notice ${noticeId}: no "Vestník č." header — notice markup changed`
    )
  }

  const match = text.match(EFORMS_VALUE) ?? text.match(LEGACY_VALUE)
  return match ? parseUvoAmount(match[1]) : null
}

/**
 * eForms writes "1 526 605.10", legacy forms write "50 000,0000". Both use a
 * space for thousands, so the decimal mark is whichever of `.`/`,` comes last.
 */
function parseUvoAmount(raw: string): number | null {
  const digits = raw.replace(/[\s ]/g, "")
  const lastComma = digits.lastIndexOf(",")
  const lastDot = digits.lastIndexOf(".")
  const normalised =
    lastDot > lastComma
      ? digits.replace(/,/g, "")
      : digits.replace(/\./g, "").replace(",", ".")
  return parseAmount(normalised)
}

/**
 * Walks a tender's notices oldest-first and returns the first estimated value
 * found. Oldest-first because the call-for-tenders notice carries the estimate
 * while later corrections and change notices usually do not.
 *
 * Costs 1 + N requests, so the loader must call it only for tenders whose value
 * is still unknown — same incremental discipline as the RPO lookup cache.
 */
export async function fetchUvoTenderValue(
  uvoId: number
): Promise<UvoTenderValue | null> {
  const notices = (await fetchUvoNotices(uvoId)).sort((a, b) =>
    (a.publishedOn ?? "").localeCompare(b.publishedOn ?? "")
  )
  for (const notice of notices.slice(0, MAX_NOTICES_PER_TENDER)) {
    await sleep(REQUEST_DELAY_MS)
    const estimatedValueEur = await fetchUvoNoticeValue(notice.noticeId)
    if (estimatedValueEur !== null) {
      return {
        uvoId,
        noticeId: notice.noticeId,
        estimatedValueEur,
        noticeCode: notice.code,
      }
    }
  }
  return null
}
