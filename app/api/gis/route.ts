import { NextResponse } from "next/server"

import { getGisFeatures } from "@/lib/queries"

/**
 * Viewport-scoped GeoJSON for one GIS layer.
 *
 * The map asks for what it can currently see, which is the only way 47 795
 * stored features become usable in a browser.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const layer = params.get("layer")
  const bboxParam = params.get("bbox")
  if (!layer || !bboxParam) {
    return NextResponse.json(
      { error: "layer and bbox are required" },
      { status: 400 }
    )
  }

  const bbox = bboxParam.split(",").map(Number)
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    return NextResponse.json(
      { error: "bbox must be minLon,minLat,maxLon,maxLat" },
      { status: 400 }
    )
  }

  const { features, capped, total } = await getGisFeatures(
    layer,
    bbox as [number, number, number, number]
  )

  return NextResponse.json({
    type: "FeatureCollection",
    capped,
    total,
    features: features.map((feature) => ({
      type: "Feature",
      id: feature.id,
      properties: { label: feature.label, ...feature.props },
      geometry: feature.geometry,
    })),
  })
}
