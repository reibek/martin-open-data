import { XMLParser } from "fast-xml-parser"

const RSS_URL = "https://www.martin.sk/rss/"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
}

export type Notice = {
  link: string
  title: string
  description: string | null
  /** Naive local timestamp; the loader converts it using Europe/Bratislava. */
  publishedAt: string
}

/**
 * The feed emits "Fri, 11 Sep 2026 12:26" — no seconds and, crucially, no
 * timezone. Parsing it with `new Date()` would silently adopt the runner's
 * timezone (UTC on CI), so the naive value is kept and converted in Postgres.
 */
function parsePubDate(raw: string): string | null {
  const match = raw
    ?.trim()
    .match(
      /^(?:\w{3},\s*)?(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/
    )
  if (!match) return null
  const [, day, monthName, year, hour, minute, second] = match
  const month = MONTHS[monthName.toLowerCase()]
  if (!month) return null
  return `${year}-${month}-${day.padStart(2, "0")} ${hour}:${minute}:${second ?? "00"}`
}

function stripHtml(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text === "" ? null : text
}

export async function fetchNotices(): Promise<Notice[]> {
  const response = await fetch(RSS_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    throw new Error(`notices: HTTP ${response.status} ${response.statusText}`)
  }

  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true })
  const feed = parser.parse(await response.text())
  const rawItems = feed?.rss?.channel?.item
  if (!rawItems)
    throw new Error("notices: source schema changed, no channel items")

  const items = Array.isArray(rawItems) ? rawItems : [rawItems]
  const notices: Notice[] = []
  for (const item of items) {
    const link = typeof item?.link === "string" ? item.link.trim() : ""
    const title = typeof item?.title === "string" ? item.title.trim() : ""
    const publishedAt = parsePubDate(String(item?.pubDate ?? ""))
    if (!link || !title || !publishedAt) continue
    notices.push({
      link,
      title,
      description: stripHtml(item?.description),
      publishedAt,
    })
  }

  if (notices.length === 0) throw new Error("notices: parsed zero usable items")
  return notices
}
