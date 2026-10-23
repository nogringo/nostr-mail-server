import { createContext, useContext } from 'react'
import en, { type Messages } from './en'
import fr from './fr'

export type Locale = 'en' | 'fr'

export const LOCALES: Locale[] = ['en', 'fr']

export const MESSAGES: Record<Locale, Messages> = { en, fr }

// English stays at the root, the other languages live under their code: /fr/dashboard.
export function localize(path: string, locale: Locale): string {
  if (locale === 'en') return path
  return path === '/' ? `/${locale}` : `/${locale}${path}`
}

// Builds each page once per language.
export function localePaths() {
  return LOCALES.map((locale) => ({ params: { locale: locale === 'en' ? undefined : locale }, props: { locale } }))
}

export const LocaleContext = createContext<Locale>('en')

export function useLocale(): Locale {
  return useContext(LocaleContext)
}

export function useMessages(): Messages {
  return MESSAGES[useLocale()]
}
