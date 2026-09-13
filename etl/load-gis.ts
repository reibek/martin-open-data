import type { Pool } from "pg"

import { fetchLayer, GIS_LAYERS } from "./gisplan"
import { insertBatched, upsertBatched } from "./load"

/**
 * Municipal asset layers: street lighting, greenery, city-owned parcels and
 * schools, from the city's own GIS.
 *
 * Each layer is loaded in its own transaction and a failure is reported without
 * taking the others down — these are several services on one server that is not
 * always quick, and losing the lighting layer should not cost the schools.
 *
 * Licence note: martin.gisplan.sk declares none — empty ows:Fees, empty
 * ows:AccessConstraints, an unconfigured provider name. It is published
 * unauthenticated by the city and is used here as public-sector information
 * with explicit attribution on the pages that show it.
 */
export async function loadGisLayers(
  pool: Pool
): Promise<Record<string, unknown>> {
  const loaded: Record<string, number> = {}
  const failed: Record<string, string> = {}

  for (const spec of GIS_LAYERS) {
    try {
      const features = await fetchLayer(spec)
      const client = await pool.connect()
      try {
        await client.query("begin")
        await upsertBatched(
          client,
          "gis_layers",
          [
            "layer",
            "service",
            "title",
            "layer_group",
            "feature_count",
            "fetched_at",
          ],
          ["layer"],
          ["service", "title", "layer_group", "feature_count", "fetched_at"],
          [
            [
              spec.typeName,
              spec.service,
              spec.title,
              spec.group,
              features.length,
              new Date().toISOString(),
            ],
          ]
        )
        await client.query("delete from gis_features where layer = $1", [
          spec.typeName,
        ])
        await insertBatched(
          client,
          "gis_features",
          [
            "layer",
            "feature_id",
            "label",
            "props",
            "geometry",
            "min_lon",
            "min_lat",
            "max_lon",
            "max_lat",
          ],
          features.map((feature) => [
            feature.layer,
            feature.featureId,
            feature.label,
            JSON.stringify(feature.props),
            JSON.stringify(feature.geometry),
            feature.bbox[0],
            feature.bbox[1],
            feature.bbox[2],
            feature.bbox[3],
          ]),
          500
        )
        await client.query("commit")
      } catch (error) {
        await client.query("rollback")
        throw error
      } finally {
        client.release()
      }
      loaded[spec.typeName] = features.length
      console.log(`  ${spec.typeName}: ${features.length}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed[spec.typeName] = message
      console.log(`  ${spec.typeName} FAILED: ${message}`)
    }
  }

  return { loaded, failed }
}
