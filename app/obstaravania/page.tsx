import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCount, formatDate, formatEur } from "@/lib/format"
import {
  getTenderStats,
  getTenderValueSummary,
  getTenders,
  getTendersByAuthority,
} from "@/lib/queries"

export const revalidate = 3600

export default async function ProcurementPage() {
  const [stats, values, tenders, byAuthority] = await Promise.all([
    getTenderStats(),
    getTenderValueSummary(),
    getTenders(60),
    getTendersByAuthority(),
  ])

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Verejné obstarávania
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Zákazky mesta Martin a mestských firiem podľa Úradu pre verejné
          obstarávanie. Faktúry ukazujú, čo sa zaplatilo — toto ukazuje, čo sa
          predtým súťažilo.
        </p>
      </header>

      {stats.total === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Žiadne zákazky</EmptyTitle>
            <EmptyDescription>
              Spusti <code>npm run etl</code>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardDescription>Zákaziek</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {formatCount(stats.total)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {stats.firstYear}–{stats.lastYear}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Vysúťažené spolu</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {values.priced > 0 ? formatEur(values.total) : "—"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  z {formatCount(values.priced)} ocenených zákaziek
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Najčastejší predmet</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-2">
                  {stats.topCpv.map((cpv) => (
                    <li key={cpv.label}>
                      <Badge variant="secondary" className="font-normal">
                        {cpv.label} · {cpv.count}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </section>

          {byAuthority.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle>Podľa obstarávateľa</CardTitle>
                <CardDescription>
                  Turčianska vodárenská spoločnosť je regionálna firma vlastnená
                  viacerými obcami, takže jej zákazky nie sú celé z martinských
                  peňazí.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Obstarávateľ</TableHead>
                        <TableHead className="text-right">Zákaziek</TableHead>
                        <TableHead className="text-right">Vysúťažené</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byAuthority.map((row) => (
                        <TableRow key={row.authority}>
                          <TableCell className="font-medium whitespace-normal">
                            {row.authority}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCount(row.count)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.total > 0 ? formatEur(row.total) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Alert>
            <AlertTitle>Predpokladané hodnoty sa dopĺňajú postupne</AlertTitle>
            <AlertDescription>
              Cena nie je vo výpise ÚVO — je až vo vestníkových oznámeniach,
              takže každá zákazka stojí ďalšie požiadavky na server, ktorý občas
              odpovedá 26 sekúnd. Dopĺňa sa po dávkach:{" "}
              {formatCount(values.priced)} zákaziek už hodnotu má
              {values.unpriced > 0
                ? `, ${formatCount(values.unpriced)} ešte neprešlo`
                : ""}
              . Približne pätina zákaziek nemá predpokladanú hodnotu zverejnenú
              vôbec.
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle>Posledné zákazky</CardTitle>
              <CardDescription>
                Najnovších 60 podľa dátumu poslednej aktualizácie v ÚVO.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Aktualizácia</TableHead>
                      <TableHead>Zákazka</TableHead>
                      <TableHead>Predmet</TableHead>
                      <TableHead className="text-right">
                        Predpokladaná hodnota
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenders.map((tender) => (
                      <TableRow key={tender.uvoId}>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDate(tender.updatedOn)}
                        </TableCell>
                        <TableCell className="max-w-md whitespace-normal">
                          <a
                            href={`https://www.uvo.gov.sk/vyhladavanie/vyhladavanie-zakaziek/detail/${tender.uvoId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium underline-offset-4 hover:underline"
                          >
                            <span className="line-clamp-2">{tender.name}</span>
                          </a>
                        </TableCell>
                        <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                          <span className="line-clamp-2">
                            {tender.cpvLabel ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                          {tender.estimatedValueEur === null
                            ? "—"
                            : formatEur(tender.estimatedValueEur)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <footer className="text-sm text-muted-foreground">
        Zdroj:{" "}
        <a
          href="https://www.uvo.gov.sk/vyhladavanie/vyhladavanie-zakaziek?obstarIco=00316792"
          className="underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          Úrad pre verejné obstarávanie
        </a>
        . ÚVO neposkytuje na tieto výpisy strojové rozhranie, takže ide o
        scrapovanie HTML — zmena rozloženia stránky pipeline zhodí, a to zámerne
        hlasno.
      </footer>
    </main>
  )
}
