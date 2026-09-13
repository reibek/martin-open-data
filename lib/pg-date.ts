import pg from "pg"

/**
 * node-postgres turns a Postgres `date` into a JS Date at LOCAL midnight. Any
 * later `.toISOString()` then converts that back to UTC and, at a positive
 * offset like Europe/Bratislava, silently moves the calendar day back by one —
 * an invoice issued on 2026-09-01 renders as 2026-08-31.
 *
 * A `date` has no time and no zone, so it is handed through as the plain
 * "YYYY-MM-DD" string the server sent and never becomes a Date at all.
 * Timestamps (timestamptz) are unaffected and keep their normal parsing.
 */
export function configureDateParsing(): void {
  pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value)
}
