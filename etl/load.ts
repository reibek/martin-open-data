import { Pool, type PoolClient } from "pg"
import { readFile } from "node:fs/promises"

import { configureDateParsing } from "../lib/pg-date"

configureDateParsing()

export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is not set")
  return new Pool({
    connectionString,
    ssl: connectionString.includes("localhost")
      ? undefined
      : { rejectUnauthorized: true },
  })
}

export async function applySchema(db: Pool | PoolClient): Promise<void> {
  const schema = await readFile(
    new URL("../db/schema.sql", import.meta.url),
    "utf8"
  )
  await db.query(schema)
}

/**
 * Postgres caps a statement at 65 535 parameters, so rows go in in chunks.
 */
export async function insertBatched(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  batchSize = 1000
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value)
        return `$${params.length}`
      })
      return `(${placeholders.join(",")})`
    })
    await client.query(
      `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`,
      params
    )
  }
}

/**
 * Upsert variant for the sources that DO have a natural key — air readings and
 * notices, which accumulate rather than being replaced wholesale.
 */
export async function upsertBatched(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  conflictColumns: readonly string[],
  updateColumns: readonly string[],
  rows: readonly unknown[][],
  batchSize = 500
): Promise<void> {
  const conflict =
    updateColumns.length > 0
      ? `on conflict (${conflictColumns.join(", ")}) do update set ${updateColumns
          .map((column) => `${column} = excluded.${column}`)
          .join(", ")}`
      : `on conflict (${conflictColumns.join(", ")}) do nothing`

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value)
        return `$${params.length}`
      })
      return `(${placeholders.join(",")})`
    })
    await client.query(
      `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")} ${conflict}`,
      params
    )
  }
}
