const USER_AGENT =
  "martin-open-data/0.1 (+https://github.com/andrej-rabek/martin-open-data)"

/** The orders export takes ~40 s to generate server-side before streaming. */
const TIMEOUT_MS = 300_000

/**
 * Fetches one dataset and fails loudly if the portal's field names changed —
 * silent nulls in a daily pipeline are far worse than a red build.
 */
export async function fetchDataset<T>(
  name: string,
  url: string,
  requiredFields: readonly string[]
): Promise<T[]> {
  const startedAt = Date.now()
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status} ${response.statusText}`)
  }
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("json")) {
    throw new Error(
      `${name}: expected JSON, got "${contentType}" (redirect not followed?)`
    )
  }

  const rows = (await response.json()) as T[]
  if (!Array.isArray(rows)) throw new Error(`${name}: expected an array`)
  if (rows.length === 0) throw new Error(`${name}: dataset is empty`)

  const missing = requiredFields.filter(
    (field) => !(field in (rows[0] as object))
  )
  if (missing.length > 0) {
    throw new Error(
      `${name}: source schema changed, missing fields: ${missing.join(", ")}`
    )
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `  fetched ${name}: ${rows.length.toLocaleString("sk")} rows in ${seconds}s`
  )
  return rows
}
