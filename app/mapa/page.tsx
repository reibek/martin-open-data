import { CityMapLoader } from "@/components/city-map-loader"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { formatCount } from "@/lib/format"
import { getDistricts, getGisLayers } from "@/lib/queries"

// Five minutes, not an hour. The data lands in bursts — the nightly ETL fills
// several tables at once — and there is no cache invalidation hook, so an
// hour-long window meant the site served an empty state long after the
// database had the rows. At this traffic a short window costs nothing and
// Neon scales to zero between requests anyway.
export const revalidate = 300

export default async function MapPage() {
  const [districts, layers] = await Promise.all([
    getDistricts(),
    getGisLayers(),
  ])
  const total = layers.reduce((sum, layer) => sum + layer.featureCount, 0)

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Mapa mesta</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Pasporty mesta Martin — osvetlenie, zeleň, vlastný majetok a školy.{" "}
          {formatCount(total)} prvkov z mestského GIS.
        </p>
      </header>

      {layers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Žiadne vrstvy</EmptyTitle>
            <EmptyDescription>
              Spusti <code>npm run etl</code>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Alert>
            <AlertTitle>Vrstvy sa načítavajú podľa výrezu</AlertTitle>
            <AlertDescription>
              Zeleň má 21 402 drevín a 11 039 plôch — naraz sa to do prehliadača
              poslať nedá, takže sa načíta vždy len to, čo je práve na
              obrazovke. Ak je vrstva príliš hustá, prepínač to povie a treba si
              mapu priblížiť.
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle>Vrstvy</CardTitle>
              <CardDescription>
                Prerušovaná čiara sú hranice mestských častí.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CityMapLoader districts={districts} layers={layers} />
            </CardContent>
          </Card>
        </>
      )}

      <footer className="text-sm text-muted-foreground">
        Zdroj:{" "}
        <a
          href="https://martin.gisplan.sk/"
          className="underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          GISPLAN mesta Martin
        </a>{" "}
        (WFS). Služba nedeklaruje licenciu; je zverejňovaná mestom bez
        obmedzenia prístupu a použitá tu ako informácie verejného sektora s
        uvedením zdroja.
      </footer>
    </main>
  )
}
