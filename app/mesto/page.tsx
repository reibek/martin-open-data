import { AgePyramid } from "@/components/age-pyramid"
import {
  HousingChart,
  PopulationChart,
  VitalStatsChart,
  WageChart,
} from "@/components/demography-chart"
import { DebtChart, FinancialsFlowChart } from "@/components/financials-chart"
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
import { formatCount, formatDate } from "@/lib/format"
import {
  getAgePyramid,
  getAverageWage,
  getCityFinancials,
  getDemography,
  getCityTotals,
  getElectionSummary,
  getHousing,
  getPopulationByStreet,
  getUnemployment,
} from "@/lib/queries"

export const revalidate = 3600

const MONTH = new Intl.DateTimeFormat("sk-SK", {
  month: "long",
  year: "numeric",
  timeZone: "Europe/Bratislava",
})

export default async function CityPage() {
  const [
    totals,
    ages,
    streets,
    unemployment,
    financials,
    election,
    demography,
    wages,
    housing,
  ] = await Promise.all([
    getCityTotals(),
    getAgePyramid(),
    getPopulationByStreet(30),
    getUnemployment(),
    getCityFinancials(false),
    getElectionSummary(),
    getDemography(),
    getAverageWage(),
    getHousing(),
  ])
  const latestFinancials = financials.at(-1)
  const withPopulation = demography.filter((row) => row.population !== null)
  const firstPopulation = withPopulation[0]
  const lastPopulation = withPopulation.at(-1)
  const populationChange =
    firstPopulation?.population && lastPopulation?.population
      ? lastPopulation.population - firstPopulation.population
      : null
  const latestWage = wages.at(-1)

  const city = unemployment.filter(
    (row) => row.territoryCode === "SK0316512036"
  )
  const district = unemployment.filter((row) => row.territoryCode === "SK0316")
  const latestCity = city.at(-1)
  const latestDistrict = district.at(-1)

  const stats = [
    {
      label: "Obyvateľov",
      value: totals ? formatCount(totals.residents) : "—",
      hint: totals
        ? `${formatCount(totals.women)} žien / ${formatCount(totals.men)} mužov`
        : "bez dát",
    },
    {
      label: "Ulíc v evidencii",
      value: totals ? formatCount(totals.streets) : "—",
      hint: "ulice s menej než 6 obyvateľmi sa nezverejňujú",
    },
    {
      label: `Zmena od ${firstPopulation?.year ?? "—"}`,
      value:
        populationChange === null
          ? "—"
          : `${populationChange > 0 ? "+" : "−"}${formatCount(Math.abs(populationChange))}`,
      hint: latestWage
        ? `priemerná mzda v okrese ${formatCount(latestWage.wage)} €`
        : "obyvateľov",
    },
    {
      label: "Podiel uchádzačov o prácu",
      value: latestCity?.sharePct != null ? `${latestCity.sharePct} %` : "—",
      hint: latestCity
        ? `mesto Martin, ${MONTH.format(new Date(latestCity.period))}`
        : "bez dát",
    },
    {
      label: "Okres Martin",
      value:
        latestDistrict?.sharePct != null ? `${latestDistrict.sharePct} %` : "—",
      hint: latestDistrict?.registered
        ? `${formatCount(latestDistrict.registered)} evidovaných`
        : "bez dát",
    },
  ]

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Mesto v číslach
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Demografia z evidencie obyvateľov mesta Martin a nezamestnanosť z
          otvorených dát ÚPSVaR.
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
              <p className="text-sm text-muted-foreground">{stat.hint}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Ako sa mesto mení</CardTitle>
          <CardDescription>
            Počet obyvateľov Martina od roku {firstPopulation?.year ?? "—"} a čo
            ho posúva — narodení, zomretí a migračné saldo. Zo Štatistického
            úradu SR.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {demography.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Žiadne dáta</EmptyTitle>
                <EmptyDescription>
                  Spusti <code>npm run etl</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <PopulationChart data={demography} />
              <VitalStatsChart data={demography} />
              <p className="text-xs text-muted-foreground">
                Prázdne roky sú medzery v zdroji, nie nuly — ŠÚ SR nepublikovanú
                hodnotu a presnú nulu zapisuje rovnako, tak sa tu nedopĺňa ani
                jedno.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Priemerná mzda</CardTitle>
            <CardDescription>
              Okres Martin, mesačne v eurách. Súhrn za všetky odvetvia.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {wages.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Žiadne dáta</EmptyTitle>
                  <EmptyDescription>Spusti ETL.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <WageChart data={wages} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bytová výstavba</CardTitle>
            <CardDescription>
              Okres Martin, byty začaté a dokončené.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {housing.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Žiadne dáta</EmptyTitle>
                  <EmptyDescription>Spusti ETL.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <HousingChart data={housing} />
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Veková pyramída</CardTitle>
          <CardDescription>
            Obyvatelia s trvalým pobytom po päťročných pásmach, muži vľavo, ženy
            vpravo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ages.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Žiadne dáta</EmptyTitle>
                <EmptyDescription>
                  Spusti <code>npm run etl</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <AgePyramid data={ages} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Najľudnatejšie ulice</CardTitle>
          <CardDescription>
            Podľa počtu obyvateľov s trvalým pobytom. Zobrazených je najväčších
            30.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ulica</TableHead>
                  <TableHead className="text-right">Obyvateľov</TableHead>
                  <TableHead className="text-right">Predproduktívni</TableHead>
                  <TableHead className="text-right">Produktívni</TableHead>
                  <TableHead className="text-right">Poproduktívni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {streets.map((street) => (
                  <TableRow key={street.street}>
                    <TableCell className="font-medium whitespace-normal">
                      {street.street}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(street.permanent)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(street.preProductive)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(street.productive)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(street.postProductive)}
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
          <CardTitle>Hospodárenie mesta</CardTitle>
          <CardDescription>
            Z účtovných závierok mesta Martin podaných do Registra účtovných
            závierok. Individuálna závierka mestského úradu, nie konsolidovaný
            celok.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {financials.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Žiadne závierky</EmptyTitle>
                <EmptyDescription>
                  Spusti <code>npm run etl</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <FinancialsFlowChart data={financials} />
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Bankové úvery</h3>
                <DebtChart data={financials} />
              </div>
              <p className="text-xs text-muted-foreground">
                Pozor na porovnávanie s faktúrami na hlavnej stránke: náklady tu
                sú účtovné, na akruálnom princípe vrátane odpisov a transferov,
                kým faktúry a objednávky sú zverejnené doklady vrátane DPH. Tie
                dve čísla sa nikdy nebudú rovnať.
                {latestFinancials
                  ? ` Naposledy podané ${formatDate(latestFinancials.filedOn)}.`
                  : null}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {election ? (
        <Card>
          <CardHeader>
            <CardTitle>Komunálne voľby {election.year}</CardTitle>
            <CardDescription>
              Oficiálne výsledky zo Štatistického úradu SR.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-10">
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Účasť</span>
              <span className="text-2xl tabular-nums">
                {election.turnoutPct} %
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatCount(election.voted)} z{" "}
                {formatCount(election.registered)}
              </span>
            </div>
            {election.mayor ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">
                  Zvolený primátor
                </span>
                <span className="flex items-center gap-2 text-2xl">
                  {election.mayor.name}
                  <Badge variant="secondary">{election.mayor.party}</Badge>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatCount(election.mayor.votes)} hlasov
                  {election.runnerUp
                    ? ` · druhý ${election.runnerUp.name}, ${formatCount(election.runnerUp.votes)}`
                    : null}
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Separator />

      <footer className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          Demografia:{" "}
          <a
            href="https://egov.martin.sk/default.aspx?NavigationState=1100:0:"
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            Open Data mesta Martin
          </a>{" "}
          (CC-BY). Nezamestnanosť:{" "}
          <a
            href="https://www.upsvr.gov.sk/statistiky/open-data/"
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            ÚPSVaR
          </a>
          .
        </p>
        <p>
          ÚPSVaR zverejňuje vždy len posledný mesiac, takže rad nezamestnanosti
          sa buduje až postupným zberom — zatiaľ {formatCount(city.length)}{" "}
          {city.length === 1 ? "mesiac" : "mesiacov"}.
        </p>
      </footer>
    </main>
  )
}
