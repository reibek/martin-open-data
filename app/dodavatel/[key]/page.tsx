import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  formatCount,
  formatDate,
  formatEur,
  formatEurExact,
} from "@/lib/format"
import {
  getSupplier,
  getSupplierIdentity,
  getSupplierInvoices,
} from "@/lib/queries"

export const revalidate = 3600

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ key: string }>
}) {
  const { key } = await params
  const supplier = await getSupplier(key)
  if (!supplier) notFound()

  const [invoices, identity] = await Promise.all([
    getSupplierInvoices(key, 50),
    getSupplierIdentity(key),
  ])

  const stats = [
    {
      label: "Fakturované",
      value: formatEur(supplier.invoiceTotal),
      hint: `${formatCount(supplier.invoiceCount)} faktúr`,
    },
    {
      label: "Objednané",
      value: formatEur(supplier.orderTotal),
      hint: `${formatCount(supplier.orderCount)} objednávok`,
    },
    {
      label: "Aktívny",
      value:
        supplier.byYear.length > 0
          ? `${supplier.byYear[0].year}–${supplier.byYear[supplier.byYear.length - 1].year}`
          : "—",
      hint: `${supplier.byYear.length} rokov`,
    },
  ]

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Prehľad</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{supplier.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {supplier.displayName}
          </h1>
          {identity?.ico ? (
            <Badge variant="secondary" className="tabular-nums">
              IČO {identity.ico}
            </Badge>
          ) : null}
        </div>
        {identity && identity.formerNames.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Predtým {identity.formerNames.join(", ")}. Staršie faktúry pod
            starým názvom sú v dátach vedené samostatne — zdroj neobsahuje IČO,
            takže ich spojiť nevieme.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Súhrn platieb mesta Martin tomuto dodávateľovi od roku 2011.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {stat.value}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{stat.hint}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Fakturované po rokoch</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rok</TableHead>
                  <TableHead className="text-right">Faktúr</TableHead>
                  <TableHead className="text-right">Suma</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplier.byYear.map((row) => (
                  <TableRow key={row.year}>
                    <TableCell className="tabular-nums">{row.year}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.count)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatEur(row.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Posledné faktúry</CardTitle>
          <CardDescription>
            Najnovších 50 podľa dátumu vystavenia.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Žiadne faktúry</EmptyTitle>
                <EmptyDescription>
                  Tento dodávateľ má v dátach len objednávky.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dátum</TableHead>
                    <TableHead>Predmet</TableHead>
                    <TableHead className="text-right">Suma</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatDate(invoice.issuedOn)}
                      </TableCell>
                      <TableCell className="max-w-md whitespace-normal">
                        <span className="line-clamp-2">
                          {invoice.subject ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                        {formatEurExact(invoice.amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
