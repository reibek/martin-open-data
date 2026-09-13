import {
  FIRST_USABLE_YEAR,
  SUBJECT_MAX_LEN,
  type RawContract,
  type RawInvoice,
  type RawOrder,
} from "./sources"
import { parseAmount, parseDate, supplierKey, truncate } from "./normalize"

export type SpendRow = {
  supplierName: string
  docNumber: string | null
  subject: string | null
  amountEur: number
  issuedOn: string
  publishedOn: string | null
}

export type ContractStat = {
  year: number
  kind: string
  cnt: number
  amountEur: number
}

export type TransformResult<T> = { rows: T[]; skipped: number }

function toSpendRow(
  supplierName: string,
  docNumber: string,
  subject: string,
  amount: string,
  currency: string,
  issued: string,
  published: string,
  subjectMaxLen: number
): SpendRow | null {
  if (currency?.trim() !== "EUR") return null
  const amountEur = parseAmount(amount)
  const issuedOn = parseDate(issued)
  const name = supplierName?.trim()
  if (amountEur === null || issuedOn === null || !name) return null
  if (Number(issuedOn.slice(0, 4)) < FIRST_USABLE_YEAR) return null

  return {
    supplierName: name,
    docNumber: truncate(docNumber, 64),
    subject: truncate(subject, subjectMaxLen),
    amountEur,
    issuedOn,
    publishedOn: parseDate(published),
  }
}

export function transformInvoices(
  raw: RawInvoice[]
): TransformResult<SpendRow> {
  const rows: SpendRow[] = []
  for (const record of raw) {
    const row = toSpendRow(
      record["Dodávateľ"],
      record["Číslo_faktúry"],
      record["Predmet_faktúry"],
      record["Celková_cena"],
      record["Mena"],
      record["Dátum_vystavenia"],
      record["Dátum_zverejnenia"],
      500
    )
    if (row) rows.push(row)
  }
  return { rows, skipped: raw.length - rows.length }
}

export function transformOrders(raw: RawOrder[]): TransformResult<SpendRow> {
  const rows: SpendRow[] = []
  for (const record of raw) {
    const row = toSpendRow(
      record["Dodávateľ"],
      record["Číslo_objednávky"],
      record["Text_objednávky"],
      record["Objednávka_spolu"],
      record["Mena"],
      record["Dátum_vystavenia"],
      record["Dátum_zverejnenia"],
      SUBJECT_MAX_LEN
    )
    if (row) rows.push(row)
  }
  return { rows, skipped: raw.length - rows.length }
}

/**
 * Contracts are reduced to (year, kind) totals before they ever reach the
 * database. 73% of counterparties in the source are natural persons, so no
 * row-level contract data is stored.
 */
export function transformContracts(
  raw: RawContract[]
): TransformResult<ContractStat> {
  const buckets = new Map<string, ContractStat>()
  let used = 0

  for (const record of raw) {
    if (record["Mena"]?.trim() !== "EUR") continue
    const signedOn = parseDate(record["Dátum_podpisu"])
    const year = signedOn ? Number(signedOn.slice(0, 4)) : Number(record["Rok"])
    const amountEur = parseAmount(record["Cena_celkom"])
    const kind = record["Typ"]?.trim() || "Neuvedené"
    if (
      !Number.isInteger(year) ||
      year < FIRST_USABLE_YEAR ||
      amountEur === null
    )
      continue

    const mapKey = JSON.stringify([year, kind])
    const bucket = buckets.get(mapKey) ?? { year, kind, cnt: 0, amountEur: 0 }
    bucket.cnt += 1
    bucket.amountEur += amountEur
    buckets.set(mapKey, bucket)
    used += 1
  }

  return { rows: [...buckets.values()], skipped: raw.length - used }
}

/** Picks the most frequent raw spelling as the display name for each supplier. */
export function buildSuppliers(names: readonly string[]): Map<string, string> {
  const spellings = new Map<string, Map<string, number>>()
  for (const name of names) {
    const key = supplierKey(name)
    if (!key) continue
    const counts = spellings.get(key) ?? new Map<string, number>()
    counts.set(name, (counts.get(name) ?? 0) + 1)
    spellings.set(key, counts)
  }

  const display = new Map<string, string>()
  for (const [key, counts] of spellings) {
    const best = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "sk")
    )[0][0]
    display.set(key, best)
  }
  return display
}
