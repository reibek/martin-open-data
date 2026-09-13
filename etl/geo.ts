const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

const PARKING_ZONES_URL =
  "https://datamesta.martin.sk/server/api/parking/map/parkZone"

const GISPLAN =
  "https://martin.gisplan.sk/services/mapserver/local/hranice/gservice"
const WFS = "service=WFS&version=1.1.0&request=GetFeature&srsName=EPSG:4326"

export type Ring = [number, number][]
export type PolygonGeometry = { type: "Polygon"; coordinates: Ring[] }

export type ParkingZone = {
  id: number
  zone: string
  colour: string | null
  geometry: PolygonGeometry
}

export type District = {
  id: number
  name: string
  geometry: PolygonGeometry
}

async function getText(url: string, what: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok)
    throw new Error(`${what}: HTTP ${response.status} ${response.statusText}`)
  return response.text()
}

/**
 * Parking zones come from datamesta.martin.sk, an undocumented API on the
 * city's own domain. The payload is already GeoJSON-shaped, just wrapped in an
 * ASP.NET envelope. No Last-Modified or ETag is served, so freshness can only
 * be judged by re-reading it.
 */
export async function fetchParkingZones(): Promise<ParkingZone[]> {
  const body = JSON.parse(
    await getText(PARKING_ZONES_URL, "parking zones")
  ) as {
    Data?: { Items?: unknown[] }
  }
  const items = body.Data?.Items
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      "parking zones: source schema changed, Data.Items missing or empty"
    )
  }

  return items.map((raw) => {
    const item = raw as {
      properties?: {
        I_PARK_ZONA_GEO?: number
        N_ZONA?: string
        PARK_ZONA_STYLE?: string
      }
      geometry?: PolygonGeometry
    }
    const id = item.properties?.I_PARK_ZONA_GEO
    const zone = item.properties?.N_ZONA
    if (typeof id !== "number" || !zone || item.geometry?.type !== "Polygon") {
      throw new Error("parking zones: unexpected feature shape")
    }
    return {
      id,
      zone,
      colour: item.properties?.PARK_ZONA_STYLE ?? null,
      geometry: item.geometry,
    }
  })
}

/**
 * MapServer answers GML 3.1.1, not GeoJSON — outputformat=geojson is not
 * enabled on this server. In GML with srsName=EPSG:4326 the posList is
 * "lat lon lat lon …", the opposite of GeoJSON's [lon, lat], so every pair is
 * swapped on the way in.
 */
function parseGmlPolygons(xml: string): Map<number, PolygonGeometry> {
  const members = xml.split("<gml:featureMember>").slice(1)
  const byId = new Map<number, PolygonGeometry>()

  for (const member of members) {
    const idMatch = member.match(/<ms:ogc_fid>(\d+)<\/ms:ogc_fid>/)
    if (!idMatch) continue

    const rings: Ring[] = []
    for (const ring of member.matchAll(
      /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g
    )) {
      const numbers = ring[1].trim().split(/\s+/).map(Number)
      if (numbers.length < 8 || numbers.length % 2 !== 0) continue
      const coordinates: Ring = []
      for (let i = 0; i < numbers.length; i += 2) {
        coordinates.push([numbers[i + 1], numbers[i]])
      }
      rings.push(coordinates)
    }
    if (rings.length === 0) continue
    byId.set(Number(idMatch[1]), { type: "Polygon", coordinates: rings })
  }

  return byId
}

function parseGmlNames(xml: string): Map<number, string> {
  const members = xml.split("<gml:featureMember>").slice(1)
  const names = new Map<number, string>()
  for (const member of members) {
    const id = member.match(/<ms:ogc_fid>(\d+)<\/ms:ogc_fid>/)
    const name = member.match(/<ms:nazov>([^<]+)<\/ms:nazov>/)
    if (id && name) names.set(Number(id[1]), name[1].trim())
  }
  return names
}

/**
 * The city's own GIS. The polygon layer carries no name — only ogc_fid — so the
 * separate label layer is fetched and joined on that id.
 *
 * Licence note: this WFS advertises empty ows:Fees and ows:AccessConstraints
 * and an unconfigured ows:ProviderName, so no open licence is actually
 * declared. It is published unauthenticated by the city, and is used here as
 * public-sector information with explicit attribution.
 */
export async function fetchDistricts(): Promise<District[]> {
  const [shapes, labels] = await Promise.all([
    getText(`${GISPLAN}?${WFS}&typename=castimesta`, "city districts"),
    getText(`${GISPLAN}?${WFS}&typename=castimesta-a`, "city district labels"),
  ])

  const geometries = parseGmlPolygons(shapes)
  const names = parseGmlNames(labels)
  if (geometries.size === 0)
    throw new Error("city districts: no polygons parsed from GML")

  const districts: District[] = []
  for (const [id, geometry] of geometries) {
    const name = names.get(id)
    if (!name) continue
    districts.push({ id, name, geometry })
  }
  if (districts.length === 0) {
    throw new Error(
      "city districts: polygons and labels share no ogc_fid — join broke"
    )
  }
  return districts
}
