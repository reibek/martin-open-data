import { formatCount } from "@/lib/format"
import type { AgeBand } from "@/lib/queries"

/**
 * Drawn as plain SVG rather than with Recharts: a vertical BarChart with
 * diverging values rendered its axes but never painted the bars, and a
 * population pyramid is a shape simple enough to place exactly. This also keeps
 * it a server component — no client JS for a static chart.
 */
const BUCKET = 5
const TOP_BUCKET = 90
const ROW_HEIGHT = 22
const BAR_HEIGHT = 15
const LABEL_WIDTH = 54
const GAP = 10
const WIDTH = 900

function toBuckets(bands: AgeBand[]) {
  const buckets = new Map<number, { men: number; women: number }>()
  for (const band of bands) {
    const floor =
      band.age >= TOP_BUCKET
        ? TOP_BUCKET
        : Math.floor(band.age / BUCKET) * BUCKET
    const bucket = buckets.get(floor) ?? { men: 0, women: 0 }
    bucket.men += band.men
    bucket.women += band.women
    buckets.set(floor, bucket)
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([floor, counts]) => ({
      label:
        floor >= TOP_BUCKET
          ? `${TOP_BUCKET}+`
          : `${floor}–${floor + BUCKET - 1}`,
      ...counts,
    }))
}

function niceTicks(max: number): number[] {
  const step = max > 2000 ? 1000 : max > 800 ? 500 : 200
  const ticks: number[] = []
  for (let value = step; value <= max; value += step) ticks.push(value)
  return ticks
}

export function AgePyramid({ data }: { data: AgeBand[] }) {
  const buckets = toBuckets(data)
  if (buckets.length === 0) return null

  const max = Math.max(
    ...buckets.flatMap((bucket) => [bucket.men, bucket.women])
  )
  const half = (WIDTH - LABEL_WIDTH - GAP * 2) / 2
  const scale = half / max
  const centre = LABEL_WIDTH + GAP + half
  const height = buckets.length * ROW_HEIGHT + 28

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label="Veková pyramída obyvateľov Martina"
    >
      <g className="stroke-border" strokeWidth={1}>
        {niceTicks(max).flatMap((tick) =>
          [-1, 1].map((side) => (
            <line
              key={`${tick}-${side}`}
              x1={centre + side * tick * scale}
              x2={centre + side * tick * scale}
              y1={0}
              y2={buckets.length * ROW_HEIGHT}
            />
          ))
        )}
      </g>

      {buckets.map((bucket, index) => {
        const y = index * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2
        return (
          <g key={bucket.label}>
            <text
              x={LABEL_WIDTH}
              y={y + BAR_HEIGHT - 3}
              textAnchor="end"
              fontSize={11}
              className="fill-muted-foreground"
            >
              {bucket.label}
            </text>
            <rect
              x={centre - bucket.men * scale}
              y={y}
              width={bucket.men * scale}
              height={BAR_HEIGHT}
              rx={2}
              fill="var(--chart-1)"
            />
            <rect
              x={centre}
              y={y}
              width={bucket.women * scale}
              height={BAR_HEIGHT}
              rx={2}
              fill="var(--chart-2)"
            />
          </g>
        )
      })}

      <g fontSize={11} className="fill-muted-foreground">
        {niceTicks(max).flatMap((tick) =>
          [-1, 1].map((side) => (
            <text
              key={`t-${tick}-${side}`}
              x={centre + side * tick * scale}
              y={buckets.length * ROW_HEIGHT + 16}
              textAnchor="middle"
            >
              {formatCount(tick)}
            </text>
          ))
        )}
        <text
          x={centre}
          y={buckets.length * ROW_HEIGHT + 16}
          textAnchor="middle"
        >
          0
        </text>
      </g>

      <g fontSize={12}>
        <rect
          x={centre - 110}
          y={height - 12}
          width={10}
          height={10}
          rx={2}
          fill="var(--chart-1)"
        />
        <text x={centre - 95} y={height - 3} className="fill-muted-foreground">
          Muži
        </text>
        <rect
          x={centre + 40}
          y={height - 12}
          width={10}
          height={10}
          rx={2}
          fill="var(--chart-2)"
        />
        <text x={centre + 55} y={height - 3} className="fill-muted-foreground">
          Ženy
        </text>
      </g>
    </svg>
  )
}
