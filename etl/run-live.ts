import type { Pool, PoolClient } from "pg"

import { fetchReadings, fetchStation, MARTIN_STATION_ID } from "./air"
import { applySchema, createPool, upsertBatched } from "./load"
import { fetchMartinGauges } from "./hydro"
import { fetchUnemployment } from "./labour"
import { fetchNotices } from "./notices"

/**
 * The fast half of the pipeline: air quality and the notice board.
 *
 * Runs several times a day because SHMU only serves a rolling 24-hour window —
 * a once-daily schedule would leave no overlap, so a single missed run would
 * punch a permanent hole in the stored history.
 *
 * Each source is fetched and stored on its own. They used to share one
 * transaction, and between 15 and 24 Sep 2026 a timing-out martin.sk RSS feed
 * or one bad SHMU value threw away every source's rows, costing 75 hours of air
 * readings that SHMU had rotated out by the next run. A failed source now
 * costs only itself; the run is recorded as 'partial' and still exits non-zero
 * so the Actions run goes red.
 */
async function main(): Promise<void> {
  const startedAt = Date.now()
  const pool = createPool()
  await applySchema(pool)

  const { rows: runRows } = await pool.query<{ id: string }>(
    `insert into etl_runs (status) values ('running-live') returning id`
  )
  const runId = runRows[0].id

  try {
    console.log("Fetching live sources…")
    const detail: Record<string, unknown> = {}
    const failed: Record<string, string> = {}

    const attempt = async (name: string, work: () => Promise<void>) => {
      try {
        await work()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`  ${name} FAILED: ${message}`)
        failed[name] = message
      }
    }

    await attempt("air", async () => {
      const station = await fetchStation(MARTIN_STATION_ID)
      const { readings, skipped } = await fetchReadings(MARTIN_STATION_ID)
      await inTransaction(pool, async (client) => {
        await upsertBatched(
          client,
          "air_stations",
          ["station_id", "name", "lat", "lon"],
          ["station_id"],
          ["name", "lat", "lon"],
          [[station.stationId, station.name, station.lat, station.lon]]
        )

        await upsertBatched(
          client,
          "air_pollutants",
          ["pollutant_id", "label"],
          ["pollutant_id"],
          ["label"],
          station.pollutants.map((pollutant) => [pollutant.id, pollutant.label])
        )

        await upsertBatched(
          client,
          "air_readings",
          ["station_id", "pollutant", "measured_at", "value", "limit_level"],
          ["station_id", "pollutant", "measured_at"],
          ["value", "limit_level"],
          readings.map((reading) => [
            reading.stationId,
            reading.pollutant,
            reading.measuredAt,
            reading.value,
            reading.limitLevel,
          ])
        )
      })

      const [stored] = (
        await pool.query<{ total: string }>(
          "select count(*) as total from air_readings"
        )
      ).rows
      detail.readings = readings.length
      detail.readingsSkipped = skipped
      detail.readingsStored = Number(stored.total)
      console.log(
        `  station ${station.name}, ${readings.length} readings` +
          (skipped ? ` (${skipped} non-numeric skipped)` : "") +
          `, ${stored.total} in history`
      )
    })

    await attempt("notices", async () => {
      const notices = await fetchNotices()
      await inTransaction(pool, async (client) => {
        // The RSS feed publishes naive local timestamps; this makes Postgres
        // resolve them (and their DST offset) correctly on insert.
        await client.query("set local time zone 'Europe/Bratislava'")
        await upsertBatched(
          client,
          "notices",
          ["link", "title", "description", "published_at"],
          ["link"],
          ["title", "description", "published_at"],
          notices.map((notice) => [
            notice.link,
            notice.title,
            notice.description,
            notice.publishedAt,
          ])
        )
      })
      detail.notices = notices.length
      console.log(`  ${notices.length} notices`)
    })

    await attempt("hydro", async () => {
      const gauges = await fetchMartinGauges()
      await inTransaction(pool, async (client) => {
        await upsertBatched(
          client,
          "hydro_stations",
          ["station_id", "name"],
          ["station_id"],
          ["name"],
          gauges.stations.map((station) => [station.stationId, station.name])
        )

        await upsertBatched(
          client,
          "hydro_readings",
          ["station_id", "measured_at", "level_cm"],
          ["station_id", "measured_at"],
          ["level_cm"],
          gauges.readings.map((reading) => [
            reading.stationId,
            reading.measuredAt,
            reading.levelCm,
          ])
        )
      })
      detail.hydroPoints = gauges.readings.length
      console.log(`  ${gauges.readings.length} hydro points`)
    })

    await attempt("labour", async () => {
      const unemployment = await fetchUnemployment()
      await inTransaction(pool, async (client) => {
        await upsertBatched(
          client,
          "unemployment",
          [
            "territory_code",
            "territory_name",
            "period",
            "registered",
            "available",
            "share_pct",
          ],
          ["territory_code", "period"],
          ["territory_name", "registered", "available", "share_pct"],
          unemployment.map((row) => [
            row.territoryCode,
            row.territoryName,
            row.period,
            row.registered,
            row.available,
            row.sharePct,
          ])
        )
      })
      detail.labourPeriod = unemployment[0]?.period ?? null
      console.log(
        `  ${unemployment.length} labour rows (${unemployment[0]?.period})`
      )
    })

    const failedNames = Object.keys(failed)
    if (failedNames.length > 0) detail.failed = failed
    detail.durationMs = Date.now() - startedAt

    await pool.query(
      `update etl_runs set status = $3, finished_at = now(), detail = $2 where id = $1`,
      [runId, detail, failedNames.length > 0 ? "partial" : "ok"]
    )
    console.log(
      `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
        (failedNames.length > 0 ? ` — FAILED: ${failedNames.join(", ")}` : "")
    )
    if (failedNames.length > 0) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pool.query(
      `update etl_runs set status = 'failed', finished_at = now(), detail = $2 where id = $1`,
      [runId, { error: message }]
    )
    throw error
  } finally {
    await pool.end()
  }
}

async function inTransaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("begin")
    await work(client)
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
