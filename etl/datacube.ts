import type { Pool } from "pg"

import { insertBatched } from "./load"

const BASE = "https://data.statistics.sk/api/v2/dataset"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/**
 * Martin the municipality (50 138 people mid-2025) and okres Martin, the
 * district around it (92 512) — the okres cubes therefore cover roughly twice
 * the city, which the /mesto page has to say out loud.
 */
const MARTIN_OBEC = "SK0316512036"
const OKRES_MARTIN = "SK0316"

/** 500 ms between cubes — four polite requests to a national statistics API. */
const PAUSE_MS = 500

type PathSegment = {
  /** Dimension id, asserted against the response in this exact order. */
  dim: string
  /** Either "all" or a comma-separated list of category codes. */
  select: string
  /**
   * For a single pinned code whose MEANING the series depends on: the label
   * the source must still give it. A code that is silently re-pointed changes
   * what the numbers are without changing anything the parser can see.
   */
  expect?: string
}

type CubeSpec = {
  cube: string
  title: string
  territoryLevel: "obec" | "okres"
  /**
   * One segment per cube dimension. The API counts these exactly, and the
   * first one is always the territory — there is no second copy of that code.
   */
  path: readonly PathSegment[]
  indicatorDim: string
  breakdownDim: string | null
  /** Floor on non-null cells; a source that goes quiet must fail, not store 0. */
  minValues: number
}

/**
 * The four cubes that actually carry Martin at municipality or district level
 * and a series long enough to plot. Every selector below was executed against
 * the live API, not inferred from the catalogue.
 */
const SPECS: readonly CubeSpec[] = [
  {
    cube: "om7103rr",
    title: "Pohyb obyvateľstva — mesto Martin (ročne)",
    territoryLevel: "obec",
    path: [
      { dim: "om7103rr_obc", select: MARTIN_OBEC },
      { dim: "om7103rr_obd", select: "all" },
      {
        dim: "om7103rr_ukaz",
        // Counts and balances only. The cube also carries abortion, stillbirth
        // and infant-mortality counts for this one town of 50 000 — aggregate,
        // so not personal data, but annual figures in the low tens that this
        // project has no dashboard use for. Deliberately not requested.
        select: [
          "IN010114", // stredný stav obyvateľstva
          "IN010115", // stav na konci obdobia
          "IN010106", // živonarodení
          "IN010061", // zomretí
          "IN010076", // prirodzený prírastok
          "IN010078", // prisťahovaní
          "IN010079", // vysťahovaní
          "IN010080", // migračné saldo
          "IN010082", // celkový prírastok
          "IN010071", // sobáše
          "IN010073", // rozvody
        ].join(","),
      },
    ],
    indicatorDim: "om7103rr_ukaz",
    breakdownDim: null,
    minValues: 300,
  },
  {
    cube: "np3110rr",
    title: "Priemerná mesačná mzda podľa SK NACE — okres Martin",
    territoryLevel: "okres",
    path: [
      { dim: "nuts14", select: OKRES_MARTIN },
      { dim: "np3110rr_rok", select: "all" },
      {
        dim: "np3110rr_ukaz",
        select: "E_PRIEM_MZDA",
        expect: "Priemerná mesačná mzda zamestnanca (Eur)",
      },
      // Pohlavie. Code "3" is the both-sexes total; asserted by label because
      // the whole series silently becomes a different population otherwise.
      { dim: "np3110rr_dim1", select: "3", expect: "Spolu" },
      // NACE section. NOTE for anything that charts this: the categories
      // OVERLAP — "SPOLU" is the grand total and "B_C_D_E" repeats the four
      // sections B, C, D and E, which are also present individually. Summing
      // the breakdown column double- and triple-counts.
      { dim: "np3110rr_dim2", select: "all" },
    ],
    indicatorDim: "np3110rr_ukaz",
    breakdownDim: "np3110rr_dim2",
    minValues: 250,
  },
  {
    cube: "st3004rr",
    title: "Byty — okres Martin",
    territoryLevel: "okres",
    path: [
      { dim: "nuts14", select: OKRES_MARTIN },
      { dim: "st3004rr_rok", select: "all" },
      { dim: "st3004rr_ukaz", select: "all" },
    ],
    indicatorDim: "st3004rr_ukaz",
    breakdownDim: null,
    minValues: 100,
  },
  {
    cube: "pr5001rr",
    title: "Evidovaní uchádzači o zamestnanie — mesto Martin (ročne)",
    territoryLevel: "obec",
    path: [
      { dim: "nuts15", select: MARTIN_OBEC },
      { dim: "pr5001rr_rok", select: "all" },
      { dim: "pr5001rr_ukaz", select: "all" },
    ],
    indicatorDim: "pr5001rr_ukaz",
    breakdownDim: null,
    minValues: 50,
  },
]

/** Cube provenance for the loader's scoped delete and for the /mesto page. */
export const DATACUBE_CUBES = SPECS.map((spec) => ({
  cube: spec.cube,
  title: spec.title,
  territoryCode: spec.path[0].select,
  territoryLevel: spec.territoryLevel,
}))

export type DatacubeRow = {
  cube: string
  territoryCode: string
  territoryName: string
  year: number
  indicator: string
  indicatorLabel: string
  /** "" when the cube has no extra dimension; a NACE section for np3110rr. */
  breakdown: string
  breakdownLabel: string | null
  value: number
  /** The cube's own publication date, already "YYYY-MM-DD". Never re-parsed. */
  sourceUpdated: string
}

type Category = {
  index?: Record<string, number> | string[]
  label?: Record<string, string>
}

type JsonStat = {
  class?: string
  update?: string
  id?: string[]
  size?: number[]
  role?: { time?: string[]; geo?: string[]; metric?: string[] }
  // When a territory is rejected the category collapses to [] — see below.
  dimension?: Record<string, { note?: string; category?: Category | unknown[] }>
  value?: (number | string | null)[] | Record<string, number | string | null>
}

/** Labels arrive with NBSP inside them: "Byty - dokončené v<NBSP>danom roku". */
const clean = (value: string) => value.replace(/ /g, " ").trim()

/** JSON-stat says value is numeric, but this is a Slovak service: "1 919,76". */
function toNumber(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null
  const cleaned = raw.replace(/[\s ]/g, "").replace(",", ".")
  if (cleaned === "") return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Category keys in position order. `index` is a map here, an array in the spec. */
function categoryKeys(category: Category | unknown[] | undefined): string[] {
  if (!category || Array.isArray(category)) return []
  const index = category.index
  if (Array.isArray(index)) return index
  if (index && typeof index === "object") {
    return Object.entries(index)
      .sort((a, b) => a[1] - b[1])
      .map(([key]) => key)
  }
  return []
}

function categoryLabel(
  category: Category | unknown[] | undefined,
  key: string
): string | null {
  if (!category || Array.isArray(category)) return null
  const label = category.label?.[key]
  return label ? clean(label) : null
}

/**
 * ŠÚ SR DATAcube, JSON-stat 2.0. Three things about this API bite hard.
 *
 * First, a selection the cube does not carry is NOT an error. An okres code in
 * an obce cube, plain nonsense, a withdrawn indicator, a dead Pohlavie code —
 * all answer HTTP 200 with a complete, well-formed header, that dimension's
 * `size` set to 0, `"value": []` and its `category` degraded from an object to
 * an empty ARRAY (so `category.index` is undefined, not an empty map). Reading
 * it naively stores nothing and reports success, so a zero-cell response
 * throws and names the dimension that actually collapsed.
 *
 * The nastier version has no zero anywhere: a pinned code that is re-pointed
 * to a different category keeps returning a full, plausible grid. `dim1=3` is
 * what makes the wage series the both-sexes one and the slice is not in the
 * stored row, so every pinned code is additionally asserted by its label.
 *
 * Second, the URL path must carry exactly one segment per cube dimension
 * (`.../dataset/om7103rr/{obec}/{rok}/{ukaz}`) or the API replies HTTP 400
 * "Bad number of dimension cubes in the request! Expected = 3 Real = 4" — and
 * the response always reports one dimension MORE than the path takes, a
 * trailing `{cube}_data` metric dim. Asking for every dimension at once on a
 * wide cube gets HTTP 400 "Too many results!", so np3110rr is sliced to the
 * both-sexes average wage before the NACE dimension is opened up.
 *
 * Third, the response returns the cube's own category order, not the order the
 * codes were requested in, so nothing may be read positionally — every cell is
 * resolved through `category.index`.
 *
 * And one lie worth knowing: a balance of exactly zero comes back as null, not
 * as 0. Martin recorded 467 births and 467 deaths in 2014 and om7103rr answers
 * null for the natural increase that year — across 33 years and the three
 * balance indicators not one literal 0 is ever published. Null cells are
 * therefore skipped rather than stored, so the chart shows a gap; do NOT
 * coalesce them to zero, because the same null also marks the 27 wage cells
 * ŠÚ SR suppresses for NACE sections B and E in okres Martin, where zero
 * would be an outright falsehood.
 */
export async function fetchDatacubeSeries(): Promise<DatacubeRow[]> {
  const rows: DatacubeRow[] = []
  for (const [position, spec] of SPECS.entries()) {
    if (position > 0) await new Promise((done) => setTimeout(done, PAUSE_MS))
    rows.push(...(await fetchCube(spec)))
  }
  return rows
}

function cubeUrl(spec: CubeSpec): string {
  const path = spec.path.map((segment) => segment.select).join("/")
  return `${BASE}/${spec.cube}/${path}?lang=sk&type=json`
}

async function fetchCube(spec: CubeSpec): Promise<DatacubeRow[]> {
  const url = cubeUrl(spec)
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  })

  // The documented failures ("Too many results!", "Bad number of dimension
  // cubes…") arrive as HTTP 400 with the reason in the body. Surface it.
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `datacube ${spec.cube}: HTTP ${response.status} ${clean(detail).slice(0, 200)}`
    )
  }

  const body = (await response.json()) as JsonStat
  if (body.class !== "dataset") {
    throw new Error(
      `datacube ${spec.cube}: expected class "dataset", got "${body.class}"`
    )
  }

  const ids = body.id ?? []
  const size = body.size ?? []
  const dimensions = body.dimension ?? {}
  if (ids.length === 0 || ids.length !== size.length) {
    throw new Error(
      `datacube ${spec.cube}: source schema changed, id/size mismatch ` +
        `(${ids.length} ids, ${size.length} sizes)`
    )
  }

  // The path dimensions must still be the leading dimensions, in order — this
  // is the same count the URL encodes, so drift here means the URL is wrong.
  const expected = spec.path.map((segment) => segment.dim)
  const actual = ids.slice(0, expected.length)
  if (expected.join("|") !== actual.join("|")) {
    throw new Error(
      `datacube ${spec.cube}: dimension layout changed, expected ` +
        `[${expected.join(", ")}] got [${ids.join(", ")}]`
    )
  }

  const geoDim = body.role?.geo?.[0] ?? expected[0]
  const timeDim = body.role?.time?.[0]
  if (!timeDim || !ids.includes(timeDim)) {
    throw new Error(`datacube ${spec.cube}: no time dimension in the response`)
  }

  // Trap: ANY rejected selection is HTTP 200 with that dimension's category
  // degraded to an empty array and its size set to 0 — the territory is only
  // the most common case. Name the dimension that actually collapsed, because
  // blaming the territory when the sex or indicator code died sends whoever
  // reads the 06:00 pipeline log to the wrong end of the URL.
  const geoKeys = categoryKeys(dimensions[geoDim]?.category)
  const cells = size.reduce((product, length) => product * length, 1)
  if (cells === 0 || geoKeys.length === 0) {
    const collapsed = ids.filter((id, at) => size[at] === 0)
    const blamed = collapsed.length > 0 ? collapsed : [geoDim]
    throw new Error(
      `datacube ${spec.cube}: HTTP 200 but zero cells — dimension(s) ` +
        `[${blamed.join(", ")}] came back empty for selection ` +
        `${spec.path.map((s) => `${s.dim}=${s.select}`).join(" ")} ` +
        `(size ${JSON.stringify(size)})`
    )
  }

  // Every explicitly-selected code must still exist, and a code that is pinned
  // to carry meaning must still MEAN the same thing. `np3110rr_dim1=3` is the
  // whole reason the wage series is the both-sexes one; the code survives a
  // re-pointing silently, and the sliced-away dimension is not in the stored
  // row, so nothing downstream could ever notice.
  for (const segment of spec.path) {
    if (segment.select === "all") continue
    const available = categoryKeys(dimensions[segment.dim]?.category)
    const missing = segment.select
      .split(",")
      .filter((code) => !available.includes(code))
    if (missing.length > 0) {
      throw new Error(
        `datacube ${spec.cube}: code(s) withdrawn from ${segment.dim}: ` +
          `${missing.join(", ")}`
      )
    }
    if (!segment.expect) continue
    const label = categoryLabel(
      dimensions[segment.dim]?.category,
      segment.select
    )
    if (label !== segment.expect) {
      throw new Error(
        `datacube ${spec.cube}: ${segment.dim}=${segment.select} now means ` +
          `"${label}", not "${segment.expect}" — the slice changed meaning`
      )
    }
  }

  // Anything the spec does not account for must be a single-category dimension
  // (the trailing metric dim). A cube that grows a real one has to be re-read.
  const accounted = new Set([
    geoDim,
    timeDim,
    spec.indicatorDim,
    ...(spec.breakdownDim ? [spec.breakdownDim] : []),
  ])
  const unexpected = ids.filter((id, at) => !accounted.has(id) && size[at] > 1)
  if (unexpected.length > 0) {
    throw new Error(
      `datacube ${spec.cube}: unhandled dimension(s) ${unexpected.join(", ")} — ` +
        `values would be silently collapsed`
    )
  }

  const sourceUpdated = body.update ?? ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceUpdated)) {
    throw new Error(
      `datacube ${spec.cube}: unusable update date "${body.update}"`
    )
  }

  const keys = ids.map((id) => categoryKeys(dimensions[id]?.category))
  const strides = size.map(() => 1)
  for (let at = size.length - 2; at >= 0; at--) {
    strides[at] = strides[at + 1] * size[at + 1]
  }
  const positionOf = (id: string) => ids.indexOf(id)
  const geoAt = positionOf(geoDim)
  const timeAt = positionOf(timeDim)
  const indicatorAt = positionOf(spec.indicatorDim)
  const breakdownAt = spec.breakdownDim ? positionOf(spec.breakdownDim) : -1

  const territoryName =
    categoryLabel(dimensions[geoDim]?.category, geoKeys[0]) ?? geoKeys[0]
  const values = body.value
  const rows: DatacubeRow[] = []

  for (let flat = 0; flat < cells; flat++) {
    const at = (dim: number) => Math.floor(flat / strides[dim]) % size[dim]
    const raw = Array.isArray(values) ? values[flat] : values?.[String(flat)]
    const value = toNumber(raw)
    // Null is either a suppressed cell or an exactly-zero balance (see above);
    // it is never stored, and never turned into a 0.
    if (value === null) continue

    const period = keys[timeAt][at(timeAt)]
    if (!/^\d{4}$/.test(period)) {
      throw new Error(
        `datacube ${spec.cube}: period "${period}" is not a plain year — ` +
          `this is not the annual cube`
      )
    }
    const indicator = keys[indicatorAt][at(indicatorAt)]
    const breakdown = breakdownAt >= 0 ? keys[breakdownAt][at(breakdownAt)] : ""

    rows.push({
      cube: spec.cube,
      territoryCode: keys[geoAt][at(geoAt)],
      territoryName,
      year: Number(period),
      indicator,
      indicatorLabel:
        categoryLabel(dimensions[spec.indicatorDim]?.category, indicator) ??
        indicator,
      breakdown,
      breakdownLabel:
        breakdownAt >= 0 && spec.breakdownDim
          ? categoryLabel(dimensions[spec.breakdownDim]?.category, breakdown)
          : null,
      value,
      sourceUpdated,
    })
  }

  if (rows.length < spec.minValues) {
    throw new Error(
      `datacube ${spec.cube}: only ${rows.length} values, expected at least ` +
        `${spec.minValues} — the series was truncated at source`
    )
  }
  return rows
}

const DATACUBE_COLUMNS = [
  "cube",
  "territory_code",
  "territory_name",
  "year",
  "indicator",
  "indicator_label",
  "breakdown",
  "breakdown_label",
  "value",
  "source_updated",
] as const

/**
 * SNAPSHOT, scoped per (cube, territory_code).
 *
 * Every call returns the complete series from the first published year, so no
 * history exists only because the pipeline kept collecting it — unlike
 * air_readings or the monthly UPSVaR file. And the source REVISES years it has
 * already published: the om7103rr note says in plain Slovak that 1993–1995
 * were corrected on 31.3.2025 and the mid/end-year stocks corrected again on
 * 23.7.2025, and that the current year is preliminary and updated all year.
 * Upserting would keep a withdrawn number forever; only a replace converges.
 *
 * Scoped rather than a global truncate because the cubes are four separate
 * HTTP calls — one dead endpoint must not wipe thirty years the API was still
 * happy to serve. In practice fetchDatacubeSeries throws before the database
 * is touched at all, since every cube is fetched before anything is written.
 *
 * `source_updated` is passed as the plain "YYYY-MM-DD" string the API sent and
 * is never turned into a Date, so it cannot shift a day at +02:00.
 */
export async function loadDatacubeSeries(
  pool: Pool
): Promise<Record<string, unknown>> {
  console.log("Fetching ŠÚ SR DATAcube…")
  const rows = await fetchDatacubeSeries()
  const perCube = DATACUBE_CUBES.map((cube) => ({
    cube: cube.cube,
    rows: rows.filter((row) => row.cube === cube.cube).length,
  }))
  console.log(
    `  ${rows.length} values — ` +
      perCube.map((c) => `${c.cube} ${c.rows}`).join(", ")
  )

  const client = await pool.connect()
  try {
    await client.query("begin")
    for (const cube of DATACUBE_CUBES) {
      await client.query(
        "delete from datacube_series where cube = $1 and territory_code = $2",
        [cube.cube, cube.territoryCode]
      )
    }
    await insertBatched(
      client,
      "datacube_series",
      DATACUBE_COLUMNS,
      rows.map((row) => [
        row.cube,
        row.territoryCode,
        row.territoryName,
        row.year,
        row.indicator,
        row.indicatorLabel,
        row.breakdown,
        row.breakdownLabel,
        row.value,
        row.sourceUpdated,
      ])
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }

  return { values: rows.length, cubes: perCube }
}
