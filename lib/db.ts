import { Pool } from "pg"

import { configureDateParsing } from "./pg-date"

configureDateParsing()

// Next.js dev server hot-reloads modules, so the pool is cached on globalThis
// to avoid leaking a connection pool per reload.
const globalForDb = globalThis as unknown as { pool?: Pool }

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is not set")
  return new Pool({
    connectionString,
    ssl: connectionString.includes("localhost")
      ? undefined
      : { rejectUnauthorized: true },
    max: 5,
  })
}

export const pool = globalForDb.pool ?? createPool()
if (process.env.NODE_ENV !== "production") globalForDb.pool = pool

export async function query<T>(
  sql: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const result = await pool.query(sql, params as unknown[])
  return result.rows as T[]
}
