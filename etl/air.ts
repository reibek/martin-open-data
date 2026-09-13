const STATIONS_URL = "https://www.shmu.sk/api/v1/airquality/getstations"
const DATA_URL = "https://www.shmu.sk/api/v1/airquality/getdata"

/** Martin, Jesenského — the only air quality station inside the city. */
export const MARTIN_STATION_ID = 99271

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

type RawStation = {
  station_id: number
  station_name: string
  gps_lat: number | null
  gps_lon: number | null
  pollutants: { pollutant_id: string; pollutant_desc: string }[]
}

type RawSeries = {
  station_id: number
  data: {
    dt: number
    value: number | null
    pollutant_id: string
    limit_level: number | null
  }[]
}

export type Station = {
  stationId: number
  name: string
  lat: number | null
  lon: number | null
  pollutants: { id: string; label: string }[]
}

export type AirReading = {
  stationId: number
  pollutant: string
  measuredAt: string
  value: number
  limitLevel: number | null
}

/**
 * This SHMU endpoint is undocumented, so every response is shape-checked and a
 * mismatch aborts the run rather than silently writing nothing.
 */
async function getJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export async function fetchStation(stationId: number): Promise<Station> {
  const stations = await getJson<RawStation[]>(STATIONS_URL, "air stations")
  if (!Array.isArray(stations))
    throw new Error("air stations: expected an array")

  const station = stations.find((entry) => entry.station_id === stationId)
  if (!station) {
    throw new Error(`air stations: station ${stationId} is no longer published`)
  }
  if (!Array.isArray(station.pollutants)) {
    throw new Error("air stations: source schema changed, `pollutants` missing")
  }

  return {
    stationId: station.station_id,
    name: station.station_name,
    lat: station.gps_lat,
    lon: station.gps_lon,
    pollutants: station.pollutants.map((pollutant) => ({
      id: pollutant.pollutant_id,
      label: pollutant.pollutant_desc,
    })),
  }
}

/**
 * SHMU serves a rolling ~24-hour window (25 hourly points per pollutant), so
 * this must run several times a day for the stored history to stay unbroken.
 * Readings with a null value are gaps in measurement and are dropped.
 */
export async function fetchReadings(stationId: number): Promise<AirReading[]> {
  const series = await getJson<RawSeries[]>(
    `${DATA_URL}?station=${stationId}`,
    "air readings"
  )
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error("air readings: expected a non-empty array")
  }
  const points = series[0]?.data
  if (!Array.isArray(points)) {
    throw new Error("air readings: source schema changed, `data` missing")
  }

  return points
    .filter((point) => point.value !== null)
    .map((point) => ({
      stationId,
      pollutant: point.pollutant_id,
      measuredAt: new Date(point.dt * 1000).toISOString(),
      value: point.value as number,
      limitLevel: point.limit_level,
    }))
}
