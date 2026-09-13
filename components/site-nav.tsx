import Link from "next/link"

import { Button } from "@/components/ui/button"

const LINKS = [
  { href: "/", label: "Prehľad" },
  { href: "/mesto", label: "Mesto v číslach" },
  { href: "/obstaravania", label: "Obstarávania" },
  { href: "/mapa", label: "Mapa" },
  { href: "/parkovanie", label: "Parkovanie" },
  { href: "/hladat", label: "Hľadať" },
]

export function SiteNav() {
  return (
    <header className="border-b">
      <nav className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-1 px-4 py-2">
        <Link href="/" className="me-3 font-semibold tracking-tight">
          Otvorené dáta Martin
        </Link>
        {LINKS.map((link) => (
          <Button key={link.href} asChild variant="ghost" size="sm">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </nav>
    </header>
  )
}
