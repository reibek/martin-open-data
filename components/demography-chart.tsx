"use client"

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatCount } from "@/lib/format"
import type { DemographyYear, HousingYear, WageYear } from "@/lib/queries"

const populationConfig = {
  population: { label: "Obyvateľov", color: "var(--chart-1)" },
} satisfies ChartConfig

const vitalConfig = {
  births: { label: "Narodení", color: "var(--chart-1)" },
  deaths: { label: "Zomretí", color: "var(--chart-2)" },
  migration: { label: "Migračné saldo", color: "var(--chart-3)" },
} satisfies ChartConfig

const wageConfig = {
  wage: { label: "Priemerná mzda", color: "var(--chart-1)" },
} satisfies ChartConfig

const housingConfig = {
  completed: { label: "Dokončené", color: "var(--chart-1)" },
  started: { label: "Začaté", color: "var(--chart-2)" },
} satisfies ChartConfig

const YEAR_AXIS = {
  dataKey: "year",
  tickLine: false,
  axisLine: false,
  tickMargin: 10,
  minTickGap: 24,
} as const

export function PopulationChart({ data }: { data: DemographyYear[] }) {
  return (
    <ChartContainer
      config={populationConfig}
      className="aspect-auto h-[260px] w-full"
    >
      <LineChart data={data} accessibilityLayer margin={{ left: 4, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis {...YEAR_AXIS} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={60}
          domain={["dataMin - 2000", "dataMax + 2000"]}
          tickFormatter={(value: number) =>
            String(Math.round(value / 1000)) + " tis."
          }
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          dataKey="population"
          type="monotone"
          stroke="var(--color-population)"
          strokeWidth={2}
          dot={false}
          connectNulls

          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

export function VitalStatsChart({ data }: { data: DemographyYear[] }) {
  return (
    <ChartContainer
      config={vitalConfig}
      className="aspect-auto h-[260px] w-full"
    >
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis {...YEAR_AXIS} />
        <YAxis tickLine={false} axisLine={false} width={50} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.3} />
        <Bar
          dataKey="births"
          fill="var(--color-births)"
          radius={2}
          isAnimationActive={false}
        />
        <Bar
          dataKey="deaths"
          fill="var(--color-deaths)"
          radius={2}
          isAnimationActive={false}
        />
        <Bar
          dataKey="migration"
          fill="var(--color-migration)"
          radius={2}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}

export function WageChart({ data }: { data: WageYear[] }) {
  return (
    <ChartContainer
      config={wageConfig}
      className="aspect-auto h-[220px] w-full"
    >
      <LineChart data={data} accessibilityLayer margin={{ left: 4, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis {...YEAR_AXIS} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={58}
          // Wages run 800–1900 EUR; rounding to thousands would print "2 tis."
          // for most of the axis, so they are shown in full euros.
          tickFormatter={(value: number) => `${formatCount(value)} €`}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          dataKey="wage"
          type="monotone"
          stroke="var(--color-wage)"
          strokeWidth={2}
          dot={{ r: 2 }}

          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

export function HousingChart({ data }: { data: HousingYear[] }) {
  return (
    <ChartContainer
      config={housingConfig}
      className="aspect-auto h-[220px] w-full"
    >
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis {...YEAR_AXIS} />
        <YAxis tickLine={false} axisLine={false} width={50} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="started"
          fill="var(--color-started)"
          radius={2}
          isAnimationActive={false}
        />
        <Bar
          dataKey="completed"
          fill="var(--color-completed)"
          radius={2}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
