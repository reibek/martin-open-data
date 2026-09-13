"use client"

import dynamic from "next/dynamic"

import { Skeleton } from "@/components/ui/skeleton"
import type { District, ParkingZone } from "@/lib/queries"

/**
 * Leaflet reads `window` at module evaluation, so the map cannot be part of the
 * server render at all. `ssr: false` is only allowed inside a client component,
 * hence this thin loader between the server page and the map itself.
 */
const ZoneMap = dynamic(
  () => import("./zone-map").then((module) => module.ZoneMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[520px] w-full rounded-md" />,
  }
)

export function ZoneMapLoader(props: {
  districts: District[]
  zones: ParkingZone[]
}) {
  return <ZoneMap {...props} />
}
