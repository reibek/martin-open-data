"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatEurCompact } from "@/lib/format"
import type { YearSpend } from "@/lib/queries"

const chartConfig = {
  invoices: { label: "Faktúry", color: "var(--chart-1)" },
  orders: { label: "Objednávky", color: "var(--chart-2)" },
} satisfies ChartConfig

export function SpendingChart({ data }: { data: YearSpend[] }) {
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[320px] w-full"
    >
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="year"
          tickLine={false}
          tickMargin={10}
          axisLine={false}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickFormatter={formatEurCompact}
          width={70}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="invoices"
          fill="var(--color-invoices)"
          radius={4}
          isAnimationActive={false}
        />
        <Bar
          dataKey="orders"
          fill="var(--color-orders)"
          radius={4}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
