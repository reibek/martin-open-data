import Link from "next/link"

import { AirChart } from "@/components/air-chart"
import { SpendingChart } from "@/components/spending-chart"
import { Badge } from "@/components/ui/badge"
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
import { Separator } from "@/components/ui/separator"
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
  formatDateTime,
  formatEur,
} from "@/lib/format"
import {
  getAirLatest,
  getAirSeries,
  getContractKinds,
  getContractTotals,
  getHydro,
  getLastRun,
  getNotices,
  getOverview,
  getSpendByYear,
  getTopSuppliers,
} from "@/lib/queries"

// Five minutes, not an hour. The data lands in bursts — the nightly ETL fills
// several tables at once — and there is no cache invalidation hook, so an
// hour-long window meant the site served an empty state long after the
// database had the rows. At this traffic a short window costs nothing and
// Neon scales to zero between requests anyway.
export const revalidate = 300

export default async function DashboardPage() {
  const [
    overview,
    spendByYear,
    topSuppliers,
    lastRun,
    airLatest,
    airSeries,
    notices,
    hydro,
    contractKinds,
    contractTotals,
  ] = await Promise.all([
    getOverview(),
    getSpendByYear(),
    getTopSuppliers(25),
    getLastRun(),
    getAirLatest(),
    getAirSeries(48),
    getNotices(8),
    getHydro(72),
    getContractKinds(8),
    getContractTotals(),
  ])

  const stats = [
    {
      label: `Výdavky ${overview.latestYear}`,
      value: formatEur(overview.latestYearTotal),
      hint: `${formatCount(overview.latestYearCount)} dokladov`,
    },
    {
      label: "Celkom od roku 2011",
      value: formatEur(overview.allTimeTotal),
      hint: `${formatCount(overview.documentCount)} dokladov`,
    },
    {
      label: "Dodávateľov",
      value: formatCount(overview.supplierCount),
      hint: "po zlúčení variantov názvu",
    },
    {
      label: "Najväčší dodávateľ",
      value: formatEur(overview.topSupplierTotal),
      hint: overview.topSupplierName,
    },
  ]

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Otvorené dáta mesta Martin
          </h1>
          {lastRun ? (
            <Badge variant="secondary">
              Aktualizované {formatDate(lastRun.finishedAt)}
            </Badge>
          ) : null}
        </div>
        <p className="max-w-3xl text-muted-foreground">
          Faktúry a objednávky mesta Martin od roku 2011, spracované z
          oficiálneho open-data portálu. Zmluvy sú zahrnuté len v agregovanej
          podobe — bez mien protistrán.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {stat.value}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="truncate text-sm text-muted-foreground">
                {stat.hint}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Výdavky po rokoch</CardTitle>
          <CardDescription>
            Súčet faktúr a objednávok podľa dátumu vystavenia. Rok{" "}
            {overview.latestYear} je neúplný.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SpendingChart data={spendByYear} />
        </CardContent>
      </Card>

      {contractTotals ? (
        <Card>
          <CardHeader>
            <CardTitle>Zmluvy podľa typu</CardTitle>
            <CardDescription>
              {formatCount(contractTotals.count)} zmlúv v{" "}
              {formatCount(contractTotals.kinds)} typoch, spolu{" "}
              {formatEur(contractTotals.total)}. Toto nie sú výdavky — zmluva je
              záväzok, nie platba, dodatky sa rátajú zvlášť od pôvodnej zmluvy a
              časť zmlúv je príjmová alebo nulová, takže s číslom výdavkov
              vyššie sa to sčítať nedá. Len agregát: mená protistrán sa zámerne
              neukladajú, 73 % z nich sú fyzické osoby.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Typ zmluvy</TableHead>
                    <TableHead className="text-right">Počet</TableHead>
                    <TableHead>Obdobie</TableHead>
                    <TableHead className="text-right">Suma</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contractKinds.map((kind) => (
                    <TableRow key={kind.kind}>
                      <TableCell className="max-w-md font-medium whitespace-normal">
                        {kind.kind}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(kind.count)}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {kind.firstYear === kind.lastYear
                          ? kind.firstYear
                          : `${kind.firstYear}–${kind.lastYear}`}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatEur(kind.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Kvalita ovzdušia</CardTitle>
            <CardDescription>
              {airLatest
                ? `${airLatest.stationName} · ${formatDateTime(airLatest.measuredAt)}`
                : "Zatiaľ bez meraní"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {airLatest ? (
              <>
                <div className="flex flex-wrap gap-8">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm text-muted-foreground">PM10</span>
                    <span className="text-2xl tabular-nums">
                      {airLatest.pm10 ?? "—"}
                      <span className="ms-1 text-sm text-muted-foreground">
                        µg/m³
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-sm text-muted-foreground">PM2.5</span>
                    <span className="text-2xl tabular-nums">
                      {airLatest.pm25 ?? "—"}
                      <span className="ms-1 text-sm text-muted-foreground">
                        µg/m³
                      </span>
                    </span>
                  </div>
                </div>
                <AirChart data={airSeries} />
                <p className="text-xs text-muted-foreground">
                  SHMÚ zverejňuje len posledných 24 hodín. Zatiaľ nazbieraných{" "}
                  {formatCount(airLatest.historyHours)} h vlastnej histórie.
                </p>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Žiadne merania</EmptyTitle>
                  <EmptyDescription>
                    Spusti <code>npm run etl:live</code> na naplnenie dát zo
                    SHMÚ.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Vodné stavy</CardTitle>
            <CardDescription>
              {hydro.length > 0
                ? "SHMÚ, stanice v Martine"
                : "Zatiaľ bez meraní"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {hydro.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Žiadne merania</EmptyTitle>
                  <EmptyDescription>
                    Spusti <code>npm run etl:live</code>.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                {hydro.map((series) => (
                  <div key={series.stationId} className="flex flex-col gap-1">
                    <span className="text-sm text-muted-foreground">
                      {series.name}
                    </span>
                    <span className="text-2xl tabular-nums">
                      {series.latest?.levelCm ?? "—"}
                      <span className="ms-1 text-sm text-muted-foreground">
                        cm
                      </span>
                    </span>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Povodňové stupne SHMÚ zverejňuje až počas povodne, preto tu
                  prahy nie sú.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Úradná tabuľa</CardTitle>
            <CardDescription>Najnovšie oznamy z martin.sk</CardDescription>
          </CardHeader>
          <CardContent>
            {notices.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Žiadne oznamy</EmptyTitle>
                  <EmptyDescription>
                    RSS zatiaľ nebolo načítané.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {notices.map((notice) => (
                  <li key={notice.link} className="flex flex-col gap-1">
                    <a
                      href={notice.link}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      <span className="line-clamp-2">{notice.title}</span>
                    </a>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(notice.publishedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Najväčší dodávatelia</CardTitle>
          <CardDescription>
            Podľa celkovej fakturovanej sumy od roku 2011.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Dodávateľ</TableHead>
                  <TableHead className="text-right">Faktúr</TableHead>
                  <TableHead>Obdobie</TableHead>
                  <TableHead className="text-right">Suma</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topSuppliers.map((supplier, index) => (
                  <TableRow key={supplier.normKey}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/dodavatel/${supplier.normKey}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {supplier.displayName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(supplier.invoiceCount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {supplier.firstYear === supplier.lastYear
                        ? supplier.firstYear
                        : `${supplier.firstYear}–${supplier.lastYear}`}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatEur(supplier.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <footer className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          Zdroj:{" "}
          <a
            href="https://egov.martin.sk/default.aspx?NavigationState=1100:0:"
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            Open Data mesta Martin
          </a>{" "}
          (licencia CC-BY) a{" "}
          <a
            href="https://www.shmu.sk/sk/?page=1&id=oko_imisie"
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            SHMÚ
          </a>
          . Dodávateľ je v zdroji iba voľný text — bez IČO, takže prepojenie na
          obchodný register nie je možné.
        </p>
        <p>
          Evidencia psov, zoznam daňových dlžníkov a mená protistrán v zmluvách
          sa zámerne nespracúvajú.
        </p>
      </footer>
    </main>
  )
}
