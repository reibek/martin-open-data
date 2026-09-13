import { inflateRawSync } from "node:zlib"

const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** Martin, okres Martin — the obec code the Statistical Office keys on. */
export const MARTIN_OBEC = "512036"

/** Only the 2022 run publishes CSV; 2018 and 2014 are XLSX/XLS only. */
export const CSV_ELECTION_YEARS = [2022] as const

export type ElectionTurnout = {
  electionYear: number
  obecCode: string
  ward: number
  precinct: number
  registered: number
  voted: number
  envelopes: number
  validCouncilBallots: number
  validMayorBallots: number
}

export type ElectionCandidate = {
  electionYear: number
  obecCode: string
  office: "mayor" | "councillor"
  ward: number
  ballotNo: number
  firstName: string
  lastName: string
  party: string
  votes: number
  elected: boolean
  withdrawn: boolean
}

export type MunicipalElection = {
  electionYear: number
  obecCode: string
  obecName: string
  seats: number
  turnout: ElectionTurnout[]
  candidates: ElectionCandidate[]
}

const HEADERS = {
  territory:
    "KRAJ|NKRAJ|OBVOD|NOBVOD|OKRES|NOKRES|OBEC|NOBEC|P_ALL_VOOBEC|P_ALL_OKRSOK|P_POS_VOL|VOLBY_TYP",
  parties: "PS|NPS|SNPS",
  mayorList: "OBEC|PC_HL|MENO|PRIEZVISKO|TITUL|VEK|ZAMESTNANIE|PS|POZNAMKA",
  councilList:
    "OBEC|VOOBEC|PC_HL|MENO|PRIEZVISKO|TITUL|VEK|ZAMESTNANIE|PS|POZNAMKA",
  turnout:
    "OBEC|VOOBEC|OKRSOK|P_ZAP|P_ZUC|UCAST|P_OO|P_OO_PCT|P_HL_ZAS|P_HL_STA",
  votes: "OBEC|VOOBEC|OKRSOK|PC_HL|P_HL|P_HL_PCT|KANDIDAT",
} as const

/** PS code 001 has no row in the party table; the manifest glosses it in prose. */
const INDEPENDENT = { code: "001", label: "NEKA" }

const entryName = (year: number, table: string) =>
  `OSO${year}_SK_tab${table}.csv`

/**
 * Reads a ZIP from memory. The archive is nine stored-then-deflated members and
 * no directory entries, so a central-directory walk plus `inflateRawSync` is the
 * whole job — adding a zip dependency for one four-yearly file is not worth it.
 */
function readZip(archive: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let at = archive.length - 22; at >= 0 && eocd < 0; at--) {
    if (archive.readUInt32LE(at) === 0x06054b50) eocd = at
  }
  if (eocd < 0) throw new Error("volby: not a ZIP — end-of-directory missing")

  const files = new Map<string, Buffer>()
  let cursor = archive.readUInt32LE(eocd + 16)
  for (let i = 0; i < archive.readUInt16LE(eocd + 10); i++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`volby: corrupt ZIP directory at entry ${i}`)
    }
    const method = archive.readUInt16LE(cursor + 10)
    const compressed = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength)
    const local = archive.readUInt32LE(cursor + 42)
    const start =
      local +
      30 +
      archive.readUInt16LE(local + 26) +
      archive.readUInt16LE(local + 28)
    const body = archive.subarray(start, start + compressed)
    if (method !== 0 && method !== 8) {
      throw new Error(`volby: ${name} uses unsupported ZIP method ${method}`)
    }
    files.set(name, method === 0 ? body : inflateRawSync(body))
    cursor +=
      46 +
      nameLength +
      archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32)
  }
  return files
}

/**
 * The eight data members are pipe-delimited, LF-terminated and contain not one
 * quote character, so the dialect has no escape mechanism at all. Two real
 * consequences, both present in the 2022 file:
 *  - `tab0c` row 145 has a literal `|` inside the party name and splits into
 *    four fields; `overflow` names the column that re-absorbs the surplus.
 *  - four `tab0bd` records (obec 512010 Veľké Dravce) carry a raw LF inside
 *    ZAMESTNANIE, so a short line is stitched onto the next physical line.
 *    Those four are why the file has 42 220 lines but 42 216 records.
 * Anything that still does not land on the expected width is a schema change
 * and throws.
 */
function parseTable(
  buffer: Buffer,
  name: string,
  header: string,
  overflow?: number
): string[][] {
  const lines = buffer.toString("utf8").split("\n")
  if (lines[0] !== header) {
    throw new Error(
      `volby: ${name} header changed\n  expected ${header}\n  got      ${lines[0]}`
    )
  }

  const width = header.split("|").length
  const rows: string[][] = []
  let pending: string[] = []

  for (const line of lines.slice(1)) {
    if (line === "" && pending.length === 0) continue
    const parts = line.split("|")
    if (pending.length === 0) pending = parts
    else
      pending = [
        ...pending.slice(0, -1),
        `${pending.at(-1)} ${parts[0]}`,
        ...parts.slice(1),
      ]

    if (pending.length > width && overflow !== undefined) {
      const tail = pending.slice(
        overflow,
        overflow + pending.length - width + 1
      )
      pending = [
        ...pending.slice(0, overflow),
        tail.join("|"),
        ...pending.slice(overflow + tail.length),
      ]
    }
    if (pending.length > width) {
      throw new Error(
        `volby: ${name} row has ${pending.length} fields, expected ${width}: ${pending.join("|")}`
      )
    }
    if (pending.length === width) {
      rows.push(pending)
      pending = []
    }
  }

  if (pending.length > 0) {
    throw new Error(`volby: ${name} ends mid-record: ${pending.join("|")}`)
  }
  if (rows.length === 0) throw new Error(`volby: ${name} holds no data rows`)
  return rows
}

/**
 * Slovak counts. The CSV carries no thousands separator, but the site's JSON
 * view of the same numbers renders them as "16 963", so the separator is
 * stripped here too — JS `\s` already covers NBSP as well as a plain space.
 * The empty string is rejected rather than tolerated: `Number("")` is 0 and
 * passes `Number.isInteger`, so a future election that blanks a cell would load
 * silent zeros instead of failing. No field read here is empty in 2022.
 */
function count(raw: string, name: string): number {
  const digits = raw.replace(/\s/g, "")
  if (digits === "")
    throw new Error(`volby: ${name} is empty, expected a count`)
  const value = Number(digits)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`volby: ${name} is not a count: ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Definitive results of the municipal (OSO) election from the Statistical
 * Office bulk CSV export — one 1.8 MB ZIP per election, frozen on publication
 * day and never revised, so this runs once per election, not daily.
 *
 * Traps this function exists to absorb:
 *  - The ZIP holds two incompatible CSV dialects. `tab_info.csv` documents the
 *    other eight ("Oddeľovač;|") while being `;`-delimited, CRLF and RFC-4180
 *    quoted itself. Its column map is also stale: it calls the party key STR,
 *    the file header says PS.
 *  - The eight tables share no schema. OBEC is column 1 in seven of them and
 *    column 7 in `tab0dd`, so a line-prefix filter silently finds nothing there.
 *  - Blank is a value, not a gap. `tab05f.KANDIDAT` is empty on 17 701 of
 *    25 592 rows and means "stood, not elected"; blank POZNAMKA means "did not
 *    withdraw". Reading either as unknown loses the result.
 *  - `tab08f.P_HL_PCT` is the candidate's share of every preference vote cast
 *    in that precinct, not of voters (Martin precinct 1/1: 86 votes = 6,54% of
 *    1 314 votes, not of 262 ballots). The percentages are therefore not
 *    summable across precincts and are deliberately not read — the caller
 *    derives shares from the vote counts instead.
 *  - PS code "001" is the most common political-subject token in the file
 *    (3 306 of 6 767 mayoral candidacies) and has no row in the party table.
 *    It means NEKA, an independent. It is also the only code used but not
 *    defined — every other one of the 49 codes in use resolves via tab0c.
 *  - OKRSOK is not unique within (OBEC, VOOBEC) everywhere; see the assertion
 *    below. tab_info states a key for candidates but none for turnout.
 *
 * Privacy: the source carries VEK (age at polling day) and ZAMESTNANIE
 * (declared occupation) for every candidate. Both are dropped here, as is
 * TITUL. Name, political subject, votes and the elected flag are kept — public
 * facts about people who stood for public office. Nothing about voters exists
 * in these tables beyond precinct-level counts.
 */
export async function fetchMunicipalElection(
  electionYear: number = 2022,
  obecCode: string = MARTIN_OBEC
): Promise<MunicipalElection> {
  const url = `https://volby.statistics.sk/oso/oso${electionYear}/files/OSO${electionYear}_SK_csv.zip`
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`volby ${electionYear}: HTTP ${response.status} for ${url}`)
  }

  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.toString("latin1", 0, 2) !== "PK") {
    throw new Error(`volby ${electionYear}: response is not a ZIP`)
  }

  const files = readZip(archive)
  const member = (table: string) => {
    const buffer = files.get(entryName(electionYear, table))
    if (!buffer) {
      throw new Error(
        `volby ${electionYear}: ${entryName(electionYear, table)} missing from ZIP ` +
          `(got ${[...files.keys()].join(", ")})`
      )
    }
    return buffer
  }

  const parties = new Map<string, string>([
    [INDEPENDENT.code, INDEPENDENT.label],
  ])
  for (const [code, , abbreviation] of parseTable(
    member("0c"),
    "tab0c",
    HEADERS.parties,
    1
  )) {
    parties.set(code, abbreviation)
  }
  const label = (codes: string) =>
    codes
      .split(",")
      .filter((code) => code !== "")
      .map((code) => {
        const name = parties.get(code)
        if (!name) throw new Error(`volby: unknown political subject ${code}`)
        return name
      })
      .join(", ")

  const territory = parseTable(member("0dd"), "tab0dd", HEADERS.territory).find(
    (row) => row[6] === obecCode
  )
  if (!territory) {
    throw new Error(`volby ${electionYear}: obec ${obecCode} not in tab0dd`)
  }
  const obecName = territory[7]
  const seats = count(territory[10], "tab0dd.P_POS_VOL")

  const mine = (rows: string[][]) => rows.filter((row) => row[0] === obecCode)

  const turnout = mine(
    parseTable(member("02bf"), "tab02bf", HEADERS.turnout)
  ).map((row) => ({
    electionYear,
    obecCode,
    ward: count(row[1], "tab02bf.VOOBEC"),
    precinct: count(row[2], "tab02bf.OKRSOK"),
    registered: count(row[3], "tab02bf.P_ZAP"),
    voted: count(row[4], "tab02bf.P_ZUC"),
    envelopes: count(row[6], "tab02bf.P_OO"),
    validCouncilBallots: count(row[8], "tab02bf.P_HL_ZAS"),
    validMayorBallots: count(row[9], "tab02bf.P_HL_STA"),
  }))
  const precincts = count(territory[9], "tab0dd.P_ALL_OKRSOK")
  if (turnout.length !== precincts) {
    throw new Error(
      `volby ${electionYear}: ${obecCode} has ${turnout.length} turnout rows, ` +
        `tab0dd declares ${precincts} precincts`
    )
  }

  // OKRSOK is unique within (OBEC, VOOBEC) in 2 919 of 2 920 obce — but not in
  // Košice (599981), where precinct numbers restart inside each mestská časť, a
  // column tab02bf does not carry. Its 198 rows hold only 187 distinct keys.
  // Row by row that is a silent loss of 11 precincts; batched it is an opaque
  // "ON CONFLICT DO UPDATE command cannot affect row a second time". Named here
  // because the storage key is (election_year, obec_code, ward, precinct).
  const seen = new Set<string>()
  for (const row of turnout) {
    const key = `${row.ward}/${row.precinct}`
    if (seen.has(key)) {
      throw new Error(
        `volby ${electionYear}: ${obecCode} repeats turnout key ward ` +
          `${row.ward} precinct ${row.precinct} — OKRSOK is not unique within ` +
          `this obec, so it cannot be stored under ` +
          `(election_year, obec_code, ward, precinct)`
      )
    }
    seen.add(key)
  }

  // Mayoral votes are reported per ward as well, but the office is city-wide:
  // the candidate key is the ballot number alone (tab_info says so explicitly).
  const tally = (rows: string[][], byWard: boolean) => {
    const totals = new Map<string, { votes: number; flag: string }>()
    for (const row of rows) {
      const key = byWard ? `${row[1]}/${row[3]}` : row[3]
      const entry = totals.get(key) ?? { votes: 0, flag: "" }
      entry.votes += count(row[4], "P_HL")
      if (row[6] !== "") entry.flag = row[6]
      totals.set(key, entry)
    }
    return totals
  }

  const mayorVotes = tally(
    mine(parseTable(member("05f"), "tab05f", HEADERS.votes)),
    false
  )
  const councilVotes = tally(
    mine(parseTable(member("08f"), "tab08f", HEADERS.votes)),
    true
  )

  const candidates: ElectionCandidate[] = []
  for (const row of mine(
    parseTable(member("0ad"), "tab0ad", HEADERS.mayorList)
  )) {
    const result = mayorVotes.get(row[1])
    if (!result) {
      throw new Error(
        `volby ${electionYear}: mayoral candidate ${obecCode}/${row[1]} has no tab05f rows`
      )
    }
    candidates.push({
      electionYear,
      obecCode,
      office: "mayor",
      ward: 0,
      ballotNo: count(row[1], "tab0ad.PC_HL"),
      firstName: row[2],
      lastName: row[3],
      party: label(row[7]),
      votes: result.votes,
      elected: result.flag === "1",
      withdrawn: row[8] === "X" || result.flag === "X",
    })
  }

  for (const row of mine(
    parseTable(member("0bd"), "tab0bd", HEADERS.councilList)
  )) {
    const result = councilVotes.get(`${row[1]}/${row[2]}`)
    if (!result) {
      throw new Error(
        `volby ${electionYear}: council candidate ${obecCode}/${row[1]}/${row[2]} has no tab08f rows`
      )
    }
    candidates.push({
      electionYear,
      obecCode,
      office: "councillor",
      ward: count(row[1], "tab0bd.VOOBEC"),
      ballotNo: count(row[2], "tab0bd.PC_HL"),
      firstName: row[3],
      lastName: row[4],
      party: label(row[8]),
      votes: result.votes,
      elected: result.flag === "1",
      withdrawn: row[9] === "X" || result.flag === "X",
    })
  }

  // Cross-checks against numbers the source states independently. They have
  // caught nothing yet; they exist so that a silent realignment cannot pass.
  const mayors = candidates.filter((c) => c.office === "mayor" && c.elected)
  if (mayors.length !== 1) {
    throw new Error(
      `volby ${electionYear}: ${obecCode} has ${mayors.length} elected mayors, expected 1`
    )
  }
  const councillors = candidates.filter(
    (c) => c.office === "councillor" && c.elected
  ).length
  if (councillors !== seats) {
    throw new Error(
      `volby ${electionYear}: ${obecCode} elected ${councillors} councillors, ` +
        `tab0dd declares ${seats} seats`
    )
  }
  const mayorTotal = candidates
    .filter((c) => c.office === "mayor")
    .reduce((sum, c) => sum + c.votes, 0)
  const mayorBallots = turnout.reduce((sum, t) => sum + t.validMayorBallots, 0)
  if (mayorTotal !== mayorBallots) {
    throw new Error(
      `volby ${electionYear}: mayoral votes ${mayorTotal} ≠ valid mayoral ` +
        `ballots ${mayorBallots} — tab05f and tab02bf disagree`
    )
  }

  return { electionYear, obecCode, obecName, seats, turnout, candidates }
}
