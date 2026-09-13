import { SearchIcon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCount, formatDate, formatEurExact } from "@/lib/format"
import { searchCounts, searchDocuments, type SearchTable } from "@/lib/queries"

export const revalidate = 3600

const PAGE_SIZE = 25

const TABS: { key: SearchTable; label: string; slug: string }[] = [
  { key: "invoices", label: "Faktúry", slug: "faktury" },
  { key: "orders", label: "Objednávky", slug: "objednavky" },
]

function buildHref(query: string, slug: string, page: number): string {
  const params = new URLSearchParams({ q: query, typ: slug })
  if (page > 1) params.set("strana", String(page))
  return `/hladat?${params.toString()}`
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; typ?: string; strana?: string }>
}) {
  const params = await searchParams
  const queryText = (params.q ?? "").trim()
  const activeTab = TABS.find((tab) => tab.slug === params.typ) ?? TABS[0]
  const page = Math.max(1, Number(params.strana ?? "1") || 1)

  const counts = queryText
    ? await searchCounts(queryText)
    : { invoices: 0, orders: 0 }
  const hits = queryText
    ? await searchDocuments(activeTab.key, queryText, page, PAGE_SIZE)
    : []
  const total = counts[activeTab.key]
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Vyhľadávanie v dokladoch
        </h1>
        <p className="text-sm text-muted-foreground">
          Prehľadáva predmet faktúr a objednávok aj názvy dodávateľov. Na
          diakritike nezáleží, hľadá sa aj podľa začiatku slova.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="typ" value={activeTab.slug} />
        <InputGroup className="max-w-md flex-1">
          <InputGroupAddon align="inline-start">
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            name="q"
            defaultValue={queryText}
            placeholder="napr. detske ihrisko, kompostér, dotácia"
            aria-label="Hľadaný výraz"
          />
        </InputGroup>
        <Button type="submit">Hľadať</Button>
      </form>

      {queryText ? (
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <Button
              key={tab.key}
              asChild
              variant={tab.key === activeTab.key ? "default" : "outline"}
            >
              <Link href={buildHref(queryText, tab.slug, 1)}>
                {tab.label}
                <Badge variant="secondary">
                  {formatCount(counts[tab.key])}
                </Badge>
              </Link>
            </Button>
          ))}
        </div>
      ) : null}

      {!queryText ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Zadaj hľadaný výraz</EmptyTitle>
            <EmptyDescription>
              Napríklad názov dodávateľa, typ služby alebo predmet faktúry.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : hits.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nič sa nenašlo</EmptyTitle>
            <EmptyDescription>
              Pre „{queryText}“ niet zhody medzi {activeTab.label.toLowerCase()}
              . Skús kratší výraz.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dátum</TableHead>
                      <TableHead>Dodávateľ</TableHead>
                      <TableHead>Predmet</TableHead>
                      <TableHead className="text-right">Suma</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hits.map((hit) => (
                      <TableRow key={hit.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDate(hit.issuedOn)}
                        </TableCell>
                        <TableCell className="max-w-52 whitespace-normal">
                          <Link
                            href={`/dodavatel/${hit.supplierKey}`}
                            className="font-medium underline-offset-4 hover:underline"
                          >
                            <span className="line-clamp-2">
                              {hit.supplierName}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-md whitespace-normal">
                          <span className="line-clamp-2">
                            {hit.subject ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                          {formatEurExact(hit.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Strana {formatCount(page)} z {formatCount(lastPage)} —{" "}
              {formatCount(total)} zhôd
            </p>
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text="Predchádzajúca"
                    href={buildHref(queryText, activeTab.slug, page - 1)}
                    aria-disabled={page <= 1}
                    className={
                      page <= 1 ? "pointer-events-none opacity-50" : undefined
                    }
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    text="Ďalšia"
                    href={buildHref(queryText, activeTab.slug, page + 1)}
                    aria-disabled={page >= lastPage}
                    className={
                      page >= lastPage
                        ? "pointer-events-none opacity-50"
                        : undefined
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      )}
    </main>
  )
}
