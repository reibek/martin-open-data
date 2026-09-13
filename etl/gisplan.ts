const BASE = "https://martin.gisplan.sk/services/mapserver"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

const WFS = "service=WFS&version=1.1.0&srsName=EPSG:4326"

/** The city's GIS is not fast, and this walks it a page at a time. */
const REQUEST_DELAY_MS = 300
const MAX_PAGES = 400

export type GisGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: [number, number][][] }

export type GisFeature = {
  layer: string
  featureId: number
  label: string | null
  props: Record<string, string>
  geometry: GisGeometry
  bbox: [number, number, number, number]
}

export type LayerSpec = {
  /** Service path, e.g. "common/paosv". */
  service: string
  /** WFS typeName, e.g. "osv-lam-i". */
  typeName: string
  title: string
  /** Which switch group the layer belongs to on the map. */
  group: string
  /** Attribute to surface as the feature's label, if any. */
  labelField?: string
}

/**
 * Layers worth storing, verified against GetCapabilities on 2026-09-13.
 *
 * `common/*` services are shared T-MAPY namespaces but are served from Martin's
 * own host and their contents are Martin's — every sampled coordinate falls
 * inside the city.
 */
export const GIS_LAYERS: LayerSpec[] = [
  {
    service: "common/paosv",
    typeName: "osv-lam-i",
    title: "Svietidlá",
    group: "Osvetlenie",
    labelField: "popis",
  },
  {
    service: "common/paosv",
    typeName: "osv-sto-i",
    title: "Stožiare",
    group: "Osvetlenie",
    labelField: "cislo",
  },
  {
    service: "common/paosv",
    typeName: "osv-roz-i",
    title: "Rozvádzače",
    group: "Osvetlenie",
    labelField: "cislo",
  },
  {
    service: "common/majetok",
    typeName: "majetok-c",
    title: "Vlastné parcely C",
    group: "Majetok mesta",
  },
  {
    service: "common/majetok",
    typeName: "majetok-e",
    title: "Vlastné parcely E",
    group: "Majetok mesta",
  },
  {
    service: "common/pazel",
    typeName: "pz-p-ver",
    title: "Plochy zelene",
    group: "Zeleň",
    labelField: "druh_nazev",
  },
  {
    service: "common/pazel",
    typeName: "pz-biob-ver",
    title: "Dreviny a bioprvky",
    group: "Zeleň",
  },
  // Mowing is kept apart from the greenery register on purpose: these layers say
  // what gets maintained and by whom, which is the side that meets the money.
  {
    service: "local/pzpom",
    typeName: "kosenie-pazel",
    title: "Kosené plochy",
    group: "Kosenie",
  },
  {
    service: "local/pzpom",
    typeName: "mulcovanie-pazel",
    title: "Mulčované plochy",
    group: "Kosenie",
  },
  {
    service: "local/pzpom",
    typeName: "pz-kosa",
    title: "Bioprvky — kosenie",
    group: "Kosenie",
  },
  {
    service: "local/pzpom",
    typeName: "pz-kosc",
    title: "Kosené bioprvky plošné",
    group: "Kosenie",
  },
  {
    service: "local/pzpom",
    typeName: "pz-kosd",
    title: "Bioprvky — kosenie (Brantner Fatra)",
    group: "Kosenie",
  },
  {
    service: "local/civo",
    typeName: "evstred",
    title: "Evakuačné strediská",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "evzbm",
    title: "Evakuačné zberné miesta",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "evtr",
    title: "Evakuačné trasy",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "evk",
    title: "Evakuácia",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "zapob",
    title: "Záplavové oblasti",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "ostch",
    title: "Objekty stáleho ohrozenia",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "prnd",
    title: "Výdaj prostriedkov ochrany",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "plmp-p",
    title: "Ohrozenie — plochy",
    group: "Civilná ochrana",
  },
  {
    service: "local/civo",
    typeName: "plmp-l",
    title: "Ohrozenie — línie",
    group: "Civilná ochrana",
  },
  {
    service: "local/skoly",
    typeName: "ms-s",
    title: "Materská škola — mesto",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "ms-ns",
    title: "Materská škola — iný zriaďovateľ",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "zs-s",
    title: "Základná škola — mesto",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "zs-ns",
    title: "Základná škola — iný zriaďovateľ",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "ss-s",
    title: "Stredná škola — VÚC",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "ss-ns",
    title: "Stredná škola — iný zriaďovateľ",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "vs",
    title: "Vysoká škola",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "cvc-s",
    title: "Centrum voľného času — mesto",
    group: "Školy",
  },
  {
    service: "local/skoly",
    typeName: "zus-s",
    title: "Základná umelecká škola — mesto",
    group: "Školy",
  },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function getXml(url: string, what: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`)
  return response.text()
}

/**
 * How many features the layer really holds.
 *
 * This matters more than it looks: a plain GetFeature is silently capped
 * per-layer — majetok-c returns 50 of its 2 859 rows and pz-p-ver returns 500
 * of 11 039 — and the truncated response carries no marker at all. Without
 * this number to reconcile against, the pipeline would happily store a
 * fraction of the layer and look successful.
 */
export async function fetchLayerCount(spec: LayerSpec): Promise<number> {
  const xml = await getXml(
    `${BASE}/${spec.service}/gservice?${WFS}&request=GetFeature&typename=${spec.typeName}&resultType=hits`,
    `${spec.typeName} count`
  )
  const match = xml.match(/numberOfFeatures="(\d+)"/)
  if (!match) {
    throw new Error(
      `${spec.typeName}: no numberOfFeatures in the hits response`
    )
  }
  return Number(match[1])
}

type ParsedPage = {
  /** Rows the server actually handed over — what startIndex must advance by. */
  served: number
  features: GisFeature[]
  /** Rows whose geometry this parser could not read. */
  unreadable: number
}

function parseFeatures(xml: string, spec: LayerSpec): ParsedPage {
  const members = xml.split("<gml:featureMember>").slice(1)
  const features: GisFeature[] = []
  let unreadable = 0

  for (const member of members) {
    const idMatch = member.match(/<ms:ogc_fid>(\d+)<\/ms:ogc_fid>/)
    if (!idMatch) continue

    const props: Record<string, string> = {}
    for (const attr of member.matchAll(
      /<ms:([A-Za-z_0-9]+)>([^<]*)<\/ms:\1>/g
    )) {
      if (attr[1] === "msGeometry" || attr[1] === "ogc_fid") continue
      const value = attr[2].trim()
      if (value !== "") props[attr[1]] = value
    }

    const geometry = parseGeometry(member)
    if (!geometry) {
      unreadable += 1
      continue
    }

    features.push({
      layer: spec.typeName,
      featureId: Number(idMatch[1]),
      label: spec.labelField ? (props[spec.labelField] ?? null) : null,
      props,
      geometry,
      bbox: boundsOf(geometry),
    })
  }

  return { served: members.length, features, unreadable }
}

function boundsOf(geometry: GisGeometry): [number, number, number, number] {
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates
    return [lon, lat, lon, lat]
  }
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const ring of geometry.coordinates) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  return [minLon, minLat, maxLon, maxLat]
}

/**
 * GML with srsName=EPSG:4326 writes "lat lon", the opposite of GeoJSON's
 * [lon, lat], so every pair is swapped on the way in.
 */
function parseGeometry(member: string): GisGeometry | null {
  const point = member.match(
    /<gml:Point[^>]*>[\s\S]*?<gml:pos[^>]*>([\d.\-\s]+)<\/gml:pos>/
  )
  if (point) {
    const [lat, lon] = point[1].trim().split(/\s+/).map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { type: "Point", coordinates: [lon, lat] }
  }

  const rings: [number, number][][] = []
  for (const ring of member.matchAll(
    /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g
  )) {
    const numbers = ring[1].trim().split(/\s+/).map(Number)
    if (numbers.length < 8 || numbers.length % 2 !== 0) continue
    const coordinates: [number, number][] = []
    for (let i = 0; i < numbers.length; i += 2) {
      coordinates.push([numbers[i + 1], numbers[i]])
    }
    rings.push(coordinates)
  }
  return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null
}

/**
 * Walks a layer page by page until the feature count reconciles.
 *
 * The page size is whatever the server chose for this layer — 50 on majetok,
 * 500 on pazel, large enough for all 5 841 lamps in one go on paosv — so it is
 * read off each response rather than assumed.
 *
 * `sortBy=ogc_fid` is load-bearing, not tidiness. Without it the underlying
 * query has no ORDER BY, so startIndex pages over an unstable result set:
 * walking pz-biob-ver unsorted served exactly its 21 402 rows but only 20 951
 * distinct ones, because adjacent pages repeated some rows and silently skipped
 * others. Sorted, consecutive pages are contiguous and disjoint.
 */
export async function fetchLayer(spec: LayerSpec): Promise<GisFeature[]> {
  const expected = await fetchLayerCount(spec)
  if (expected === 0) return []

  const features: GisFeature[] = []
  const seen = new Set<number>()
  // startIndex must count rows the server has ALREADY HANDED OVER, not rows we
  // decided to keep. Driving it from the deduped total makes the offset fall
  // behind the server on the first repeated id, which re-requests rows we
  // already have, which produces more repeats — the layer then never
  // reconciles and the shortfall looks like missing data rather than a bug.
  let offset = 0
  let unreadable = 0

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await sleep(REQUEST_DELAY_MS)
    const xml = await getXml(
      `${BASE}/${spec.service}/gservice?${WFS}&request=GetFeature&typename=${spec.typeName}&sortBy=ogc_fid&startIndex=${offset}`,
      `${spec.typeName} page ${page}`
    )
    const page_ = parseFeatures(xml, spec)
    if (page_.served === 0) break
    offset += page_.served
    unreadable += page_.unreadable

    for (const feature of page_.features) {
      if (seen.has(feature.featureId)) continue
      seen.add(feature.featureId)
      features.push(feature)
    }
    if (offset >= expected) break
  }

  if (features.length + unreadable !== expected) {
    throw new Error(
      `${spec.typeName}: collected ${features.length} (+${unreadable} with unreadable geometry) of ${expected} — paging did not reconcile`
    )
  }
  if (unreadable > 0) {
    console.log(
      `  ${spec.typeName}: ${unreadable} of ${expected} features have a geometry this parser cannot read and are not stored`
    )
  }
  return features
}
