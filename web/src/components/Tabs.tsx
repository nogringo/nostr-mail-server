import { useSyncExternalStore } from 'react'
import { TONES, type Tone } from './ui'

export interface TabLink<Id extends string> {
  id: Id
  label: string
  count?: number
  tone?: Tone
}

// Each tab links to its URL fragment, so a reload or the back button keeps it.
export function Tabs<Id extends string>({ label, tabs, current }: { label: string; tabs: TabLink<Id>[]; current: Id }) {
  return (
    <nav aria-label={label} className="mt-8 flex gap-x-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-rule)]">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={`#${tab.id}`}
          aria-current={tab.id === current ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap border-b-2 pb-2 font-medium text-sm focus-visible:-outline-offset-2 ${tab.id === current ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
        >
          {tab.label}
          {tab.count ? <span className={`ml-1.5 font-normal ${TONES[tab.tone ?? 'none']}`}>{tab.count}</span> : null}
        </a>
      ))}
    </nav>
  )
}

export function useHash(): string {
  return useSyncExternalStore(subscribeToHash, () => window.location.hash.slice(1))
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}
