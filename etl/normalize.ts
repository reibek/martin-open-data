import { stripDiacritics } from "../lib/text"

/** Slovak number format: space (or NBSP) thousands separator, comma decimal. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[\s ]/g, "").replace(",", ".")
  if (cleaned === "") return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Source dates are consistently DD.MM.YYYY. */
export function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const match = raw.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!match) return null
  const [, day, month, year] = match
  return `${year}-${month}-${day}`
}

const LEGAL_FORM =
  /\b(s\.?r\.?o\.?|a\.?s\.?|spol\.?|k\.?s\.?|o\.?z\.?|n\.?o\.?|szco)\b/g

/**
 * Collapses spelling variants of the same supplier ("QEX, a.s." vs "QEX,a.s.").
 * Measured on the full invoice set: 5 062 raw names collapse to 4 965 keys.
 * Deliberately deterministic — fuzzy matching is not warranted at this error rate.
 */
export function supplierKey(raw: string): string {
  return stripDiacritics(raw)
    .toLowerCase()
    .replace(LEGAL_FORM, "")
    .replace(/[^a-z0-9]+/g, "")
}

export function truncate(
  value: string | null | undefined,
  max: number
): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed === "") return null
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}
