const BASE = "https://www.shmu.sk/sk/?page=1&id=hydro_vod_za"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** The two SHMU gauges inside Martin: the Turiec river and Pivovarský potok. */
export const MARTIN_GAUGES = [6130, 6140] as const

export type HydroStation = { stationId: number; name: string }
export type HydroReading = {
  stationId: number
  /** Naive Bratislava wall-clock time; the loader converts it in Postgres. */
  measuredAt: string
  levelCm: number
}

/**
 * There is no JSON endpoint for hydrology — only the rendered page, which
 * embeds the series as a Highcharts literal:
 *   var base_serie = {id:'m', name:'Meraný vodný stav', …, data:[[ms, cm], …]};
 * So this is a scrape, and a SHMU redesign breaks it. It fails loudly rather
 * than silently returning nothing.
 *
 * The flood-stage series (1.SPA/2.SPA/3.SPA) are present but empty outside
 * flood events, so thresholds are deliberately not extracted.
 *
 * The `ms` values are NOT real epoch milliseconds. The chart runs with
 * `useUTC: true` and SHMU encodes Bratislava wall-clock time as if it were
 * UTC: at 17:17 UTC on 26 Sep 2026 the newest point decoded to 19:15 "UTC",
 * matching the page's own "26.9.2026 19:15". Read as epoch, every reading was
 * stored two hours in the future until that date.
 */
export async function fetchGauge(
  stationId: number
): Promise<{ station: HydroStation; readings: HydroReading[] }> {
  const response = await fetch(`${BASE}&station_id=${stationId}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok)
    throw new Error(`hydro ${stationId}: HTTP ${response.status}`)
  const html = await response.text()

  const label = [...html.matchAll(/option value="(\d+)"[^>]*>([^<]+)/g)].find(
    (match) => match[1] === String(stationId)
  )?.[2]
  if (!label) {
    throw new Error(
      `hydro ${stationId}: station is no longer listed on the page`
    )
  }

  const series = html.match(
    /name\s*:\s*'Meraný vodný stav'[^{}]*?data\s*:\s*\[([\s\S]*?)\]\s*\}/
  )
  if (!series) {
    throw new Error(
      `hydro ${stationId}: measured-level series not found — page layout changed`
    )
  }

  // Keyed by time because wall-clock time repeats an hour when DST ends, and
  // two rows with one key in a single upsert batch make Postgres reject it.
  const byTime = new Map<string, HydroReading>()
  for (const point of series[1].matchAll(/\[(\d{12,13}),\s*(-?[0-9.]+)\]/g)) {
    const level = Number(point[2])
    if (!Number.isFinite(level)) continue
    const measuredAt = new Date(Number(point[1]))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ")
    byTime.set(measuredAt, { stationId, measuredAt, levelCm: level })
  }
  const readings = [...byTime.values()]

  if (readings.length === 0) {
    throw new Error(`hydro ${stationId}: series parsed but held no points`)
  }

  return { station: { stationId, name: label.trim() }, readings }
}

export async function fetchMartinGauges(): Promise<{
  stations: HydroStation[]
  readings: HydroReading[]
}> {
  const stations: HydroStation[] = []
  const readings: HydroReading[] = []
  // Sequential: two polite requests to a public meteorological service.
  for (const stationId of MARTIN_GAUGES) {
    const gauge = await fetchGauge(stationId)
    stations.push(gauge.station)
    readings.push(...gauge.readings)
  }
  return { stations, readings }
}
