"use client"

import "leaflet/dist/leaflet.css"

import L from "leaflet"
import { useTheme } from "next-themes"
import { useEffect, useId, useRef, useState } from "react"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { District, GeoPolygon, ParkingZone } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * Parking zones over a real street basemap.
 *
 * An earlier version drew the polygons as bare SVG with no basemap. It was
 * cheap and it was useless: the zones are a small cluster in the centre of a
 * 12 km-wide city, so at city extent they were an unreadable blob, and without
 * streets there was no way to tell WHERE a zone is — which is the only question
 * a parking map has to answer.
 *
 * Tiles are the standard OpenStreetMap raster layer. CARTO's Positron would
 * sit better under coloured data, but its CDN burns an "API KEY REQUIRED"
 * watermark across every tile, so it is not actually keyless. OSM is, under its
 * tile usage policy, which this site's traffic is comfortably inside; a busier
 * one would need its own tile source. Dark mode inverts the tile pane only —
 * the zone colours must not be inverted with it.
 */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">prispievatelia OpenStreetMap</a>'

function toFeature(geometry: GeoPolygon, properties: Record<string, unknown>) {
  return { type: "Feature" as const, geometry, properties }
}

export function ZoneMap({
  districts,
  zones,
}: {
  districts: District[]
  zones: ParkingZone[]
}) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const zoneLayer = useRef<L.GeoJSON | null>(null)
  const [showZones, setShowZones] = useState(true)
  const { resolvedTheme } = useTheme()
  const switchId = useId()

  useEffect(() => {
    if (!container.current || map.current) return

    const instance = L.map(container.current, { scrollWheelZoom: false })
    map.current = instance

    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(
      instance
    )

    // Districts first, as thin context outlines — the basemap now carries the
    // detail that the old SVG version had to fake with a grey fill.
    L.geoJSON(
      districts.map((district) =>
        toFeature(district.geometry, { name: district.name })
      ),
      {
        style: { color: "#6b7280", weight: 1, fill: false, dashArray: "4 3" },
        interactive: false,
      }
    ).addTo(instance)

    const layer = L.geoJSON(
      zones.map((zone) => toFeature(zone.geometry, { zone: zone.zone })),
      {
        style: (feature) => ({
          color: "#ffffff",
          weight: 1,
          fillColor:
            zones.find((zone) => zone.zone === feature?.properties?.zone)
              ?.colour ?? "#888888",
          fillOpacity: 0.65,
        }),
      }
    )
    layer.bindTooltip(
      (target) =>
        String(
          (
            target as L.Path & {
              feature?: { properties?: { zone?: string } }
            }
          ).feature?.properties?.zone ?? ""
        ),
      { sticky: true }
    )
    zoneLayer.current = layer

    // Fit to the ZONES, not the city: the zones are the subject, and at city
    // extent they are a dot. The view is set once here, so toggling the zones
    // off leaves the reader where they were rather than jumping the map.
    const bounds = layer.getBounds()
    if (bounds.isValid()) instance.fitBounds(bounds, { padding: [24, 24] })

    return () => {
      instance.remove()
      map.current = null
      zoneLayer.current = null
    }
  }, [districts, zones])

  useEffect(() => {
    const instance = map.current
    const layer = zoneLayer.current
    if (!instance || !layer) return
    if (showZones) layer.addTo(instance)
    else layer.remove()
  }, [showZones])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          checked={showZones}
          onCheckedChange={setShowZones}
        />
        <Label htmlFor={switchId}>Parkovacie zóny</Label>
      </div>
      <div
        ref={container}
        className={cn(
          "h-[520px] w-full overflow-hidden rounded-md border",
          resolvedTheme === "dark" &&
            "[&_.leaflet-tile-pane]:hue-rotate-180 [&_.leaflet-tile-pane]:invert"
        )}
        role="application"
        aria-label="Mapa parkovacích zón v Martine"
      />
    </div>
  )
}
