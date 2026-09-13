"use client"

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { AirPoint } from "@/lib/queries"

const chartConfig = {
  pm10: { label: "PM10", color: "var(--chart-1)" },
  pm25: { label: "PM2.5", color: "var(--chart-2)" },
} satisfies ChartConfig

const HOUR = new Intl.DateTimeFormat("sk-SK", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Bratislava",
})

export function AirChart({ data }: { data: AirPoint[] }) {
  const points = data.map((point) => ({
    time: HOUR.format(new Date(point.measuredAt)),
    pm10: point.pm10,
    pm25: point.pm25,
  }))

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[220px] w-full"
    >
      <LineChart
        data={points}
        accessibilityLayer
        margin={{ left: 4, right: 8 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="time"
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          minTickGap={40}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          unit=""
          tickFormatter={(value: number) => String(value)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="pm10"
          type="monotone"
          stroke="var(--color-pm10)"
          strokeWidth={2}
          dot={false}
          connectNulls

          isAnimationActive={false}
        />
        <Line
          dataKey="pm25"
          type="monotone"
          stroke="var(--color-pm25)"
          strokeWidth={2}
          dot={false}
          connectNulls

          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
