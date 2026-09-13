/** Slovak diacritics are all decomposable, so NFKD + dropping marks is enough. */
export function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "")
}

/**
 * Builds a prefix tsquery ("dotac:* & ihrisko:*").
 *
 * Prefix matching stands in for stemming, which Postgres cannot do for Slovak.
 * Terms are reduced to [a-z0-9] before they reach Postgres, so no tsquery
 * operator can be injected. Single characters are dropped — a one-letter prefix
 * matches most of the corpus and only costs time.
 */
export function buildTsQuery(input: string, maxTerms = 6): string | null {
  const terms = stripDiacritics(input.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .slice(0, maxTerms)
  return terms.length === 0
    ? null
    : terms.map((term) => `${term}:*`).join(" & ")
}
