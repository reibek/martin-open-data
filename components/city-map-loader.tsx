"use client"

import dynamic from "next/dynamic"

import { Skeleton } from "@/components/ui/skeleton"
import type { District, GisLayerMeta } from "@/lib/queries"

/** Leaflet reads `window` at module scope, so the map stays out of the server render. */
const CityMap = dynamic(
  () => import("./city-map").then((module) => module.CityMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[640px] w-full rounded-md" />,
  }
)

export function CityMapLoader(props: {
  districts: District[]
  layers: GisLayerMeta[]
}) {
  return <CityMap {...props} />
}
