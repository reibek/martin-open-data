/**
 * Martin open data exports (CG eGOV portal).
 *
 * Each URL 302-redirects to /OutputStreamHttpHandler.ashx with a short-lived
 * cacheKey, so redirects must be followed. The trailing `_5_8` selects JSON.
 */
const BASE = "https://egov.martin.sk/Default.aspx?NavigationState="

export const SOURCES = {
  invoices: `${BASE}779:0::plac1929:_144102_5_8`,
  orders: `${BASE}781:0::plac1931:_144104_5_8`,
  contracts: `${BASE}778:0::plac1889:_144101_5_8`,
} as const

/** Orders carry a full itemised list; only a snippet is kept. */
export const SUBJECT_MAX_LEN = 300

/** Before 2011 the source holds only a handful of records per year. */
export const FIRST_USABLE_YEAR = 2011

export type RawInvoice = {
  Číslo_faktúry: string
  Dodávateľ: string
  Predmet_faktúry: string
  Celková_cena: string
  Mena: string
  Dátum_vystavenia: string
  Dátum_zverejnenia: string
}

export type RawOrder = {
  Číslo_objednávky: string
  Dodávateľ: string
  Text_objednávky: string
  Objednávka_spolu: string
  Mena: string
  Dátum_vystavenia: string
  Dátum_zverejnenia: string
}

export type RawContract = {
  Rok: string
  Typ: string
  Cena_celkom: string
  Mena: string
  Dátum_podpisu: string
}
