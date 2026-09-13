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
    const station = await fetchStation(MARTIN_STATION_ID)
    const readings = await fetchReadings(MARTIN_STATION_ID)
    const notices = await fetchNotices()
    const gauges = await fetchMartinGauges()
    const unemployment = await fetchUnemployment()
    console.log(
      `  station ${station.name}, ${readings.length} readings, ${notices.length} notices, ` +
        `${gauges.readings.length} hydro points, ${unemployment.length} labour rows ` +
        `(${unemployment[0]?.period})`
    )

    const client = await pool.connect()
    try {
      await client.query("begin")
      // The RSS feed publishes naive local timestamps; this makes Postgres
      // resolve them (and their DST offset) correctly on insert.
      await client.query("set local time zone 'Europe/Bratislava'")

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

      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    } finally {
      client.release()
    }

    const [stored] = (
      await pool.query<{ total: string }>(
        "select count(*) as total from air_readings"
      )
    ).rows

    await pool.query(
      `update etl_runs set status = 'ok', finished_at = now(), detail = $2 where id = $1`,
      [
        runId,
        {
          readings: readings.length,
          readingsStored: Number(stored.total),
          notices: notices.length,
          hydroPoints: gauges.readings.length,
          labourPeriod: unemployment[0]?.period ?? null,
          durationMs: Date.now() - startedAt,
        },
      ]
    )
    console.log(
      `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${stored.total} readings in history`
    )
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

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
