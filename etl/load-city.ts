import type { Pool } from "pg"

import { fetchPopulationByAge, fetchPopulationByStreet } from "./city-stats"
import { fetchDistricts, fetchParkingZones } from "./geo"
import { insertBatched, upsertBatched } from "./load"
import { resolveIco, resolveMissing } from "./rpo"

/**
 * Near-static city data plus the RPO enrichment pass.
 *
 * Kept in its own transaction, after the spending snapshot has committed: these
 * sources live on four different servers and none of them should be able to
 * roll back 248 000 rows of invoices.
 */
export async function loadCityData(
  pool: Pool
): Promise<Record<string, unknown>> {
  console.log("Fetching city data…")
  const [zones, districts, streets, ages] = await Promise.all([
    fetchParkingZones(),
    fetchDistricts(),
    fetchPopulationByStreet(),
    fetchPopulationByAge(),
  ])
  console.log(
    `  ${zones.length} parking zones, ${districts.length} districts, ` +
      `${streets.rows.length} streets (${streets.suppressed} suppressed as too small), ` +
      `${ages.length} age bands`
  )

  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query(
      "truncate parking_zones, city_districts, population_by_street, population_by_age"
    )

    await insertBatched(
      client,
      "parking_zones",
      ["id", "zone", "colour", "geometry"],
      zones.map((zone) => [
        zone.id,
        zone.zone,
        zone.colour,
        JSON.stringify(zone.geometry),
      ])
    )
    await insertBatched(
      client,
      "city_districts",
      ["id", "name", "geometry"],
      districts.map((district) => [
        district.id,
        district.name,
        JSON.stringify(district.geometry),
      ])
    )
    await insertBatched(
      client,
      "population_by_street",
      [
        "street",
        "permanent",
        "temporary",
        "women",
        "men",
        "pre_productive",
        "productive",
        "post_productive",
      ],
      streets.rows.map((row) => [
        row.street,
        row.permanent,
        row.temporary,
        row.women,
        row.men,
        row.preProductive,
        row.productive,
        row.postProductive,
      ])
    )
    await insertBatched(
      client,
      "population_by_age",
      ["age", "total", "men", "women"],
      ages.map((row) => [row.age, row.total, row.men, row.women])
    )

    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }

  const rpo = await enrichSuppliers(pool)

  return {
    parkingZones: zones.length,
    districts: districts.length,
    streets: streets.rows.length,
    streetsSuppressed: streets.suppressed,
    ageBands: ages.length,
    rpo,
  }
}

/**
 * Only suppliers invoiced this much in total are worth a lookup. 991 suppliers
 * clear it and between them account for 97.9% of all the money — resolving the
 * remaining 4 138 one-off names would cost hours of requests for 2% of spend.
 */
const MIN_SPEND_FOR_LOOKUP = 10_000

/**
 * Resolves supplier names to IČO via the national RPO register.
 *
 * Only suppliers with no cached answer are queried, biggest spend first, so the
 * cap bites on the long tail rather than on the companies anyone will look at.
 * Misses are cached too — otherwise every run would re-ask the same thousands
 * of unresolvable one-off names.
 */
async function enrichSuppliers(pool: Pool): Promise<Record<string, unknown>> {
  const { rows: pending } = await pool.query<{
    norm_key: string
    display_name: string
  }>(
    `select s.norm_key, s.display_name, sum(i.amount_eur) as total
     from suppliers s
     join invoices i on i.supplier_id = s.id
     left join supplier_ico c on c.norm_key = s.norm_key
     where c.norm_key is null
     group by s.norm_key, s.display_name
     having sum(i.amount_eur) >= $1
     order by total desc`,
    [MIN_SPEND_FOR_LOOKUP]
  )

  if (pending.length === 0) return { pending: 0, attempted: 0, matched: 0 }

  console.log(
    `Resolving IČO for ${pending.length} suppliers above ${MIN_SPEND_FOR_LOOKUP} EUR…`
  )

  const flush = async (batch: Awaited<ReturnType<typeof resolveIco>>[]) => {
    const client = await pool.connect()
    try {
      await client.query("begin")
      await upsertBatched(
        client,
        "supplier_ico",
        ["norm_key", "ico", "matched_name", "former_names", "matched"],
        ["norm_key"],
        ["ico", "matched_name", "former_names", "matched"],
        batch.map((match) => [
          match.normKey,
          match.ico,
          match.matchedName,
          match.formerNames,
          match.matched,
        ])
      )
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    } finally {
      client.release()
    }
  }

  const { attempted, matched, skipped } = await resolveMissing(
    pending.map((row) => ({
      normKey: row.norm_key,
      displayName: row.display_name,
    })),
    flush
  )
  if (skipped > 0) {
    console.log(`  ${skipped} left for the next run (per-run cap)`)
  }
  console.log(`  matched ${matched} of ${attempted}`)
  return { pending: pending.length, attempted, matched, deferred: skipped }
}
