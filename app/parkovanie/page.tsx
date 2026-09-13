import { ZoneMapLoader } from "@/components/zone-map-loader"
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
import { formatCount } from "@/lib/format"
import { getDistricts, getParkingZones } from "@/lib/queries"

// Five minutes, not an hour. The data lands in bursts — the nightly ETL fills
// several tables at once — and there is no cache invalidation hook, so an
// hour-long window meant the site served an empty state long after the
// database had the rows. At this traffic a short window costs nothing and
// Neon scales to zero between requests anyway.
export const revalidate = 300

export default async function ParkingPage() {
  const [zones, districts] = await Promise.all([
    getParkingZones(),
    getDistricts(),
  ])

  const byZone = new Map<string, { colour: string | null; count: number }>()
  for (const zone of zones) {
    const entry = byZone.get(zone.zone) ?? { colour: zone.colour, count: 0 }
    entry.count += 1
    byZone.set(zone.zone, entry)
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Parkovanie v Martine
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Spoplatnené parkovacie zóny podľa mapového podkladu mesta, nad mapou
          ulíc. Prerušovaná čiara sú hranice mestských častí.
        </p>
      </header>

      <Alert>
        <AlertTitle>Obsadenosť v reálnom čase neexistuje</AlertTitle>
        <AlertDescription>
          Martinský parkovací systém nikde nezverejňuje počty voľných miest —
          overili sme mapové API mesta, stránku prevádzkovateľa aj platobnú
          bránu. Táto mapa je preto statická: ukazuje, kde sa platí, nie kde je
          voľno.
        </AlertDescription>
      </Alert>

      {zones.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Žiadne zóny</EmptyTitle>
            <EmptyDescription>
              Spusti <code>npm run etl</code> na načítanie mapových podkladov.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Mapa zón</CardTitle>
              <CardDescription>
                {formatCount(zones.length)} plôch v {formatCount(byZone.size)}{" "}
                zónach, podklad {formatCount(districts.length)} mestských častí.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ZoneMapLoader districts={districts} zones={zones} />
              <div className="flex flex-wrap gap-3">
                {[...byZone.entries()].map(([name, info]) => (
                  <span key={name} className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className="inline-block size-3 rounded-sm"
                      style={{ backgroundColor: info.colour ?? "#888888" }}
                    />
                    {name}
                    <Badge variant="secondary">{info.count}</Badge>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Zdroje</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                <li>
                  Geometria zón:{" "}
                  <a
                    href="https://datamesta.martin.sk/server/api/parking/map/parkZone"
                    className="underline underline-offset-4"
                    target="_blank"
                    rel="noreferrer"
                  >
                    datamesta.martin.sk
                  </a>{" "}
                  — nezdokumentované mapové API mesta Martin.
                </li>
                <li>
                  Mestské časti:{" "}
                  <a
                    href="https://martin.gisplan.sk/"
                    className="underline underline-offset-4"
                    target="_blank"
                    rel="noreferrer"
                  >
                    martin.gisplan.sk
                  </a>{" "}
                  (WFS). Ani jeden z týchto zdrojov nedeklaruje licenciu; sú
                  zverejňované mestom bez obmedzenia prístupu a použité tu ako
                  informácie verejného sektora s uvedením zdroja.
                </li>
                <li>
                  Cenník a platnosť kariet zverejňuje{" "}
                  <a
                    href="https://parkovanie-martin.sk/parkovacie-zony"
                    className="underline underline-offset-4"
                    target="_blank"
                    rel="noreferrer"
                  >
                    parkovanie-martin.sk
                  </a>
                  .
                </li>
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}
