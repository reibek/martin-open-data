import { supplierKey } from "./normalize"

const SEARCH_URL = "https://api.statistics.sk/rpo/v1/search"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/**
 * sourceRegister code 2 is the trade licence register — sole traders, i.e.
 * natural persons. Their records are skipped on the same grounds the dog
 * registry and debtor list are: this project does not amplify personal data.
 */
const TRADE_LICENCE_REGISTER = "2"

/**
 * RPO answers in 2–5 seconds, so the request rate is already about 0.3/s with
 * no artificial delay at all — sequential calls are the politeness. The cap is
 * sized for the 20-minute GitHub Actions budget minus the spending load.
 */
const MAX_LOOKUPS_PER_RUN = 250
const FLUSH_EVERY = 25

export type IcoMatch = {
  normKey: string
  matched: boolean
  ico: string | null
  matchedName: string | null
  formerNames: string[]
}

type RpoName = { value: string; validFrom?: string; validTo?: string | null }
type RpoResult = {
  identifiers?: { value: string }[]
  fullNames?: RpoName[]
  sourceRegister?: { value?: { code?: string } }
}

/**
 * RPO's fullName search returns ZERO hits when the query carries the legal
 * form: "Brantner Fatra s.r.o." finds nothing, "Brantner Fatra" finds it. So
 * the form is stripped for the query only — the acceptance test below still
 * compares full normalised names, so a looser query cannot loosen the match.
 */
const TRAILING_LEGAL_FORM =
  /[,\s]+(spol\.?\s*s\s*r\.?\s*o\.?|s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?|akciová spoločnosť|v\.?\s*o\.?\s*s\.?|k\.?\s*s\.?|o\.?\s*z\.?|n\.?\s*o\.?)\s*$/i

function searchName(displayName: string): string {
  const stripped = displayName
    // Quotes and stray leading commas make RPO answer 400 outright.
    .replace(/["„“”]/g, " ")
    .replace(TRAILING_LEGAL_FORM, "")
    .replace(/^[,\s]+/, "")
    .replace(/[,\s]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  return stripped.length >= 3 ? stripped : displayName.trim()
}

async function search(name: string): Promise<RpoResult[]> {
  const response = await fetch(
    `${SEARCH_URL}?fullName=${encodeURIComponent(name)}`,
    {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    }
  )
  // A name with no hit answers 200 + empty results. A 400 means RPO rejected
  // the query string itself — flat-owner associations register under names like
  // `Spoločenstvo vlastníkov bytov "Štúrovo námestie 109"`. That is an
  // unresolvable name, not a broken service, so it has to become a cached miss:
  // throwing would leave it uncached and retried on every single run forever.
  if (response.status === 400) return []
  if (!response.ok)
    throw new Error(`rpo: HTTP ${response.status} for "${name}"`)
  const body = (await response.json()) as { results?: RpoResult[] }
  return body.results ?? []
}

/**
 * Resolves one supplier name to an IČO.
 *
 * The rule is deliberately strict: a single search hit is NOT treated as a
 * match. RPO will happily return exactly one confident-looking result for the
 * WRONG company — querying "Turvod" returns TURVOD-MH, s.r.o. while Martin's
 * actual water utility is Turčianska vodárenská spoločnosť. So a hit only
 * counts when one of its names — current or historical — normalises to the
 * same key as ours. Everything else is recorded as unmatched, on purpose.
 */
export async function resolveIco(
  normKey: string,
  displayName: string
): Promise<IcoMatch> {
  const miss: IcoMatch = {
    normKey,
    matched: false,
    ico: null,
    matchedName: null,
    formerNames: [],
  }

  const results = await search(searchName(displayName))
  if (results.length === 0) return miss

  const candidates = results.filter(
    (result) => result.sourceRegister?.value?.code !== TRADE_LICENCE_REGISTER
  )

  const exact = candidates.filter((result) =>
    (result.fullNames ?? []).some((name) => supplierKey(name.value) === normKey)
  )
  if (exact.length !== 1) return miss

  const winner = exact[0]
  const ico = winner.identifiers?.[0]?.value ?? null
  if (!ico) return miss

  const names = winner.fullNames ?? []
  const current = names.find((name) => !name.validTo) ?? names[names.length - 1]
  const former = names
    .filter((name) => name.validTo && name.value !== current?.value)
    .map((name) => name.value)

  return {
    normKey,
    matched: true,
    ico,
    matchedName: current?.value ?? displayName,
    formerNames: former,
  }
}

/**
 * Resolves suppliers that have not been looked up before, flushing partial
 * results as it goes: a run of 150 lookups takes minutes against a public
 * register, and losing all of it to one timeout would mean starting over every
 * day and never converging.
 *
 * The cache is keyed by norm_key, which survives the daily snapshot reload, so
 * this work shrinks to nothing after the first few runs.
 */
export async function resolveMissing(
  pending: readonly { normKey: string; displayName: string }[],
  flush: (batch: IcoMatch[]) => Promise<void>
): Promise<{ attempted: number; matched: number; skipped: number }> {
  const batch = pending.slice(0, MAX_LOOKUPS_PER_RUN)
  let buffer: IcoMatch[] = []
  let attempted = 0
  let matched = 0

  for (const supplier of batch) {
    try {
      const match = await resolveIco(supplier.normKey, supplier.displayName)
      buffer.push(match)
      if (match.matched) matched += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `  rpo lookup failed for "${supplier.displayName}": ${message}`
      )
    }
    attempted += 1

    if (buffer.length >= FLUSH_EVERY) {
      await flush(buffer)
      buffer = []
    }
  }

  if (buffer.length > 0) await flush(buffer)
  return { attempted, matched, skipped: pending.length - batch.length }
}
