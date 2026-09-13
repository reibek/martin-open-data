import { parseAmount } from "./normalize"

const BASE = "https://egov.martin.sk/Default.aspx?NavigationState="

const POPULATION_BY_STREET_URL = `${BASE}900:0::plac520:_144017_5_8`
const POPULATION_BY_AGE_URL = `${BASE}920:0::plac1140:_144053_5_8`

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/**
 * Streets with very few residents are dropped rather than published. A street
 * with three people on it is close to naming them, which is the same objection
 * that keeps the dog registry and the debtor list out of this project.
 */
const MIN_RESIDENTS = 6

/** The source mixes two aggregate buckets in with the real streets. */
const NOT_A_STREET = /^\*/

export type StreetPopulation = {
  street: string
  permanent: number
  temporary: number
  women: number
  men: number
  preProductive: number
  productive: number
  postProductive: number
}

export type AgePopulation = {
  age: number
  total: number
  men: number
  women: number
}

async function getJson<T>(url: string, what: string): Promise<T[]> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(`${what}: HTTP ${response.status} ${response.statusText}`)
  const rows = (await response.json()) as T[]
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${what}: expected a non-empty array`)
  }
  return rows
}

const toInt = (value: string | undefined) => Math.round(parseAmount(value) ?? 0)

export async function fetchPopulationByStreet(): Promise<{
  rows: StreetPopulation[]
  suppressed: number
}> {
  const raw = await getJson<Record<string, string>>(
    POPULATION_BY_STREET_URL,
    "population by street"
  )
  if (!("Ulica" in raw[0]) || !("Na_trvalom_pobyte" in raw[0])) {
    throw new Error("population by street: source schema changed")
  }

  const rows: StreetPopulation[] = []
  let suppressed = 0

  for (const record of raw) {
    const street = (record["Ulica"] ?? "").trim()
    if (!street || NOT_A_STREET.test(street)) continue
    const permanent = toInt(record["Na_trvalom_pobyte"])
    if (permanent < MIN_RESIDENTS) {
      suppressed += 1
      continue
    }
    rows.push({
      street,
      permanent,
      temporary: toInt(record["Na_prechodnom_pobyte"]),
      women: toInt(record["Ženy"]),
      men: toInt(record["Muži"]),
      preProductive: toInt(record["V_predproduktívnom_veku"]),
      productive: toInt(record["V_produktívnom_veku"]),
      postProductive: toInt(record["V_poproduktívnom_veku"]),
    })
  }

  if (rows.length === 0)
    throw new Error("population by street: every row was filtered out")
  return { rows, suppressed }
}

export async function fetchPopulationByAge(): Promise<AgePopulation[]> {
  const raw = await getJson<Record<string, string>>(
    POPULATION_BY_AGE_URL,
    "population by age"
  )
  if (!("Vek" in raw[0]))
    throw new Error("population by age: source schema changed")

  return raw
    .map((record) => ({
      age: toInt(record["Vek"]),
      total: toInt(record["Počet_občanov_v_danom_veku"]),
      men: toInt(record["Počet_mužov"]),
      women: toInt(record["Počet_žien"]),
    }))
    .filter((row) => Number.isInteger(row.age))
}
