"use client"

import "leaflet/dist/leaflet.css"

import L from "leaflet"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { District, GisLayerMeta } from "@/lib/queries"
import { cn } from "@/lib/utils"

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">prispievatelia OpenStreetMap</a>'

const MARTIN: [number, number] = [49.0664, 18.9219]

/**
 * Layer colours are category identifiers, the way the parking zone colours are
 * — they carry meaning, so they are data rather than a styling choice.
 */
const GROUP_COLOUR: Record<string, string> = {
  Osvetlenie: "#d97706",
  Zeleň: "#15803d",
  Kosenie: "#65a30d",
  "Majetok mesta": "#6d28d9",
  "Civilná ochrana": "#0369a1",
  Školy: "#b91c1c",
}

type Loaded = { count: number; capped: boolean; total: number }

export function CityMap({
  districts,
  layers,
}: {
  districts: District[]
  layers: GisLayerMeta[]
}) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const overlays = useRef<Map<string, L.GeoJSON>>(new Map())
  const [active, setActive] = useState<Set<string>>(new Set())
  // Mirrors `active` so the map's moveend handler, which is registered once,
  // always refetches the layers that are switched on right now.
  const activeRef = useRef(active)
  const [status, setStatus] = useState<Record<string, Loaded>>({})
  const [busy, setBusy] = useState(false)
  const { resolvedTheme } = useTheme()

  const refresh = useCallback(
    async (wanted: Set<string>) => {
      const instance = map.current
      if (!instance) return

      for (const [layer, overlay] of overlays.current) {
        if (!wanted.has(layer)) {
          overlay.remove()
          overlays.current.delete(layer)
        }
      }
      if (wanted.size === 0) return

      const b = instance.getBounds()
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(
        ","
      )
      setBusy(true)
      try {
        for (const layer of wanted) {
          const response = await fetch(
            `/api/gis?layer=${encodeURIComponent(layer)}&bbox=${bbox}`
          )
          if (!response.ok) continue
          const data = (await response.json()) as {
            features: GeoJSON.Feature[]
            capped: boolean
            total: number
          }
          overlays.current.get(layer)?.remove()

          const colour =
            GROUP_COLOUR[layers.find((l) => l.layer === layer)?.group ?? ""] ??
            "#555"
          const overlay = L.geoJSON(data.features, {
            pointToLayer: (_, latlng) =>
              L.circleMarker(latlng, {
                radius: 3,
                color: colour,
                weight: 1,
                fillColor: colour,
                fillOpacity: 0.8,
              }),
            style: {
              color: colour,
              weight: 1,
              fillColor: colour,
              fillOpacity: 0.3,
            },
          })
          overlay.bindTooltip(
            (target) => {
              const props = (target as L.Path & { feature?: GeoJSON.Feature })
                .feature?.properties as Record<string, string> | undefined
              return String(
                props?.label ?? props?.druh_nazev ?? props?.cislo ?? ""
              )
            },
            { sticky: true }
          )
          overlay.addTo(instance)
          overlays.current.set(layer, overlay)
          setStatus((previous) => ({
            ...previous,
            [layer]: {
              count: data.features.length,
              capped: data.capped,
              total: data.total,
            },
          }))
        }
      } finally {
        setBusy(false)
      }
    },
    [layers]
  )

  useEffect(() => {
    if (!container.current || map.current) return
    const instance = L.map(container.current, {
      scrollWheelZoom: false,
    }).setView(MARTIN, 13)
    map.current = instance
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(
      instance
    )
    L.geoJSON(
      districts.map((district) => ({
        type: "Feature" as const,
        geometry: district.geometry,
        properties: { name: district.name },
      })),
      {
        style: { color: "#6b7280", weight: 1, fill: false, dashArray: "4 3" },
        interactive: false,
      }
    ).addTo(instance)

    const openOverlays = overlays.current
    return () => {
      instance.remove()
      map.current = null
      openOverlays.clear()
    }
  }, [districts])

  // Re-fetch on pan and zoom: the API returns only what the viewport covers.
  useEffect(() => {
    const instance = map.current
    if (!instance) return
    const handler = () => void refresh(activeRef.current)
    instance.on("moveend", handler)
    return () => {
      instance.off("moveend", handler)
    }
  }, [refresh])

  // Fetching is driven from the toggle and from map movement — both events —
  // rather than from an effect on `active`. Loading data is a reaction to what
  // the reader did, not to a render.
  const toggle = (layer: string, on: boolean) => {
    const next = new Set(activeRef.current)
    if (on) next.add(layer)
    else next.delete(layer)
    activeRef.current = next
    setActive(next)
    void refresh(next)
  }

  const groups = [...new Set(layers.map((layer) => layer.group))]

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: GROUP_COLOUR[group] ?? "#555" }}
              />
              {group}
            </h3>
            {layers
              .filter((layer) => layer.group === group)
              .map((layer) => (
                <div key={layer.layer} className="flex items-start gap-2">
                  <Switch
                    id={`gis-${layer.layer}`}
                    checked={active.has(layer.layer)}
                    onCheckedChange={(on) => toggle(layer.layer, on)}
                  />
                  <div className="flex flex-col">
                    <Label
                      htmlFor={`gis-${layer.layer}`}
                      className="text-sm font-normal"
                    >
                      {layer.title}
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {layer.featureCount.toLocaleString("sk")}
                      {status[layer.layer]?.capped ? " · priblíž si mapu" : ""}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        ))}
        {busy ? <Badge variant="secondary">Načítavam…</Badge> : null}
      </div>

      <div
        ref={container}
        className={cn(
          "h-[640px] w-full overflow-hidden rounded-md border",
          resolvedTheme === "dark" &&
            "[&_.leaflet-tile-pane]:hue-rotate-180 [&_.leaflet-tile-pane]:invert"
        )}
        role="application"
        aria-label="Mapa mestských dát Martina"
      />
    </div>
  )
}
