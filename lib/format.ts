const EUR = new Intl.NumberFormat("sk-SK", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
})

const EUR_EXACT = new Intl.NumberFormat("sk-SK", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
})

const COUNT = new Intl.NumberFormat("sk-SK")

// Vercel runs in UTC; the zone is pinned so a late-evening local timestamp
// never renders as the previous day.
const ZONE = "Europe/Bratislava"

const DATE = new Intl.DateTimeFormat("sk-SK", {
  dateStyle: "medium",
  timeZone: ZONE,
})

const DATETIME = new Intl.DateTimeFormat("sk-SK", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: ZONE,
})

export const formatEur = (value: number) => EUR.format(value)
export const formatEurExact = (value: number) => EUR_EXACT.format(value)
export const formatCount = (value: number) => COUNT.format(value)
export const formatDate = (value: string | Date) => DATE.format(new Date(value))
export const formatDateTime = (value: string | Date) =>
  DATETIME.format(new Date(value))

/** Compact form for chart axes: 1 200 000 → "1,2 mil." */
export function formatEurCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1).replace(".", ",")} mil.`
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)} tis.`
  return String(value)
}
