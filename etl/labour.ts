const URL =
  "https://www.upsvr.gov.sk/statistiky/open-data/UoZ-01-zakladne-ukazovatele.json"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** okres Martin and the city of Martin — the only two rows of 3 018 we keep. */
const TERRITORIES = new Set(["SK0316", "SK0316512036"])

export type UnemploymentRow = {
  territoryCode: string
  territoryName: string
  period: string
  registered: number | null
  available: number | null
  sharePct: number | null
}

const toNumber = (value: string | null | undefined) => {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(String(value).replace(",", "."))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * ÚPSVaR republishes ONE month at this fixed URL, so the stored series only
 * grows because every run appends the current period. Miss enough months and
 * those months are gone — they are not reachable from this endpoint afterwards.
 *
 * Note `miera_nezamestnanosti` is null at municipality level; the metric that
 * actually exists for the city is `podiel_uoz_v_pv_na_opv` — the share of
 * job seekers of working age in the working-age population.
 */
export async function fetchUnemployment(): Promise<UnemploymentRow[]> {
  const response = await fetch(URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`unemployment: HTTP ${response.status}`)

  const body = (await response.json()) as {
    posts?: {
      description?: { period?: string }
      data?: Record<string, string | null>[]
    }
  }
  const period = body.posts?.description?.period
  const data = body.posts?.data
  if (!period || !Array.isArray(data)) {
    throw new Error(
      "unemployment: source schema changed, posts.description.period or posts.data missing"
    )
  }

  const rows = data
    .filter((record) => TERRITORIES.has(String(record["kod_nuts"] ?? "")))
    .map((record) => ({
      territoryCode: String(record["kod_nuts"]),
      territoryName: String(record["uzemie"] ?? "").trim(),
      period,
      registered: toNumber(record["stav_uoz_spolu"]),
      available: toNumber(record["disponibilny_pocet"]),
      sharePct: toNumber(record["podiel_uoz_v_pv_na_opv"]),
    }))

  if (rows.length === 0) {
    throw new Error(
      `unemployment: neither Martin territory found in ${data.length} rows`
    )
  }
  return rows
}
