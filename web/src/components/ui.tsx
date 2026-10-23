import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, useEffect, useState } from 'react'
import { type Locale, MESSAGES, useMessages } from '../i18n'

export const TONES = { ok: 'text-ok', wait: 'text-wait', bad: 'text-bad', none: 'text-muted' }

export type Tone = keyof typeof TONES

const VARIANTS = {
  primary: 'rounded-md bg-ink px-4 py-2 font-medium text-paper hover:bg-ink/85',
  secondary: 'rounded-md border border-rule px-4 py-2 font-medium hover:border-muted',
  quiet: 'text-muted underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-muted',
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={`cursor-pointer transition-colors disabled:cursor-default disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}

type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: keyof typeof VARIANTS }

export function ButtonLink({ variant = 'primary', className = '', ...props }: ButtonLinkProps) {
  return <a className={`inline-block transition-colors ${VARIANTS[variant]} ${className}`} {...props} />
}

export function BackLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="text-muted text-sm hover:text-ink">
      <span aria-hidden="true">← </span>
      {children}
    </a>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useMessages().copy
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t.label(label)}
      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-sans text-muted text-sm hover:bg-rule/60 hover:text-ink"
    >
      {state === 'copied' ? t.done : state === 'failed' ? t.failed : t.action}
    </button>
  )
}

// Named in its own language, for a reader who does not understand the current one.
export function LanguageLink({ locale, href }: { locale: Locale; href: string }) {
  return (
    <a href={href} lang={locale} hrefLang={locale} className="text-muted hover:text-ink">
      {MESSAGES[locale].language}
    </a>
  )
}

export function ErrorText({ children }: { children: string | null }) {
  if (!children) return null
  return (
    <p role="alert" className="text-bad text-sm">
      {children}
    </p>
  )
}
