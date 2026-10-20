import { type ButtonHTMLAttributes, useEffect, useState } from 'react'

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

export function CopyButton({ text, label }: { text: string; label: string }) {
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
      aria-label={`Copy ${label}`}
      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-sans text-muted text-sm hover:bg-rule/60 hover:text-ink"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
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
