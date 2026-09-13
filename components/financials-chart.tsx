"use client"

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
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
import { formatEurCompact } from "@/lib/format"
import type { FinancialYear } from "@/lib/queries"

const flowConfig = {
  revenues: { label: "Výnosy", color: "var(--chart-1)" },
  expenses: { label: "Náklady", color: "var(--chart-2)" },
} satisfies ChartConfig

const debtConfig = {
  bankLoans: { label: "Bankové úvery", color: "var(--chart-1)" },
} satisfies ChartConfig

export function FinancialsFlowChart({ data }: { data: FinancialYear[] }) {
  return (
    <ChartContainer
      config={flowConfig}
      className="aspect-auto h-[300px] w-full"
    >
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="fiscalYear"
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
          dataKey="revenues"
          fill="var(--color-revenues)"
          radius={4}
          isAnimationActive={false}
        />
        <Bar
          dataKey="expenses"
          fill="var(--color-expenses)"
          radius={4}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}

export function DebtChart({ data }: { data: FinancialYear[] }) {
  return (
    <ChartContainer
      config={debtConfig}
      className="aspect-auto h-[220px] w-full"
    >
      <LineChart data={data} accessibilityLayer margin={{ left: 4, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="fiscalYear"
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
        <Line
          dataKey="bankLoans"
          type="monotone"
          stroke="var(--color-bankLoans)"
          strokeWidth={2}
          dot={{ r: 3 }}

          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
