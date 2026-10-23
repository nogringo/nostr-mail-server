import { useState } from 'react'
import { useMessages } from '../i18n'
import type { Api, Domain, Nip05Host } from '../lib/api'
import { describeError } from '../lib/errors'
import RecordRow from './RecordRow'
import { CopyButton, ErrorText } from './ui'

const HOSTS: Nip05Host[] = ['server', 'owner']

// What NIP-05 allows: a catch-all address like you+news never resolves.
const NIP05_NAME = /^[a-z0-9._-]+$/

export default function Nip05Group({
  domain,
  api,
  onChange,
}: {
  domain: Domain
  api: Api
  onChange: (domain: Domain) => void
}) {
  const t = useMessages().nip05
  const record = domain.records.find(({ id }) => id === 'nip05')

  return (
    <div>
      <h2 className="font-medium">{t.title}</h2>
      <p className="mt-1 text-muted text-sm">{t.intro(domain.domain)}</p>
      <HostChoice domain={domain} api={api} onChange={onChange} />
      {domain.nip05 === 'server' ? (
        <p className="mt-3 text-muted text-sm">{t.serverAnswers(domain.domain)}</p>
      ) : (
        <Relay domain={domain} api={api} />
      )}
      {record && (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          <RecordRow record={record} />
        </ul>
      )}
    </div>
  )
}

function HostChoice({ domain, api, onChange }: { domain: Domain; api: Api; onChange: (domain: Domain) => void }) {
  const t = useMessages()
  const [pending, setPending] = useState<Nip05Host | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(nip05: Nip05Host) {
    setPending(nip05)
    setError(null)
    try {
      onChange(await api.setNip05Host(domain.domain, nip05))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <fieldset disabled={pending !== null} className="mt-3">
      <legend className="sr-only">{t.nip05.hostLegend(domain.domain)}</legend>
      <div className="space-y-1.5 text-sm">
        {HOSTS.map((value) => (
          <label key={value} className="flex w-fit cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="nip05"
              checked={(pending ?? domain.nip05) === value}
              onChange={() => choose(value)}
              className="accent-accent"
            />
            {t.nip05.hosts[value]}
          </label>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </fieldset>
  )
}

function Relay({ domain, api }: { domain: Domain; api: Api }) {
  const t = useMessages().nip05
  const relayUrl = `${window.location.origin}/nip05/${domain.domain}`

  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted">{t.relay}</p>
      <Snippet text={relayUrl} label={t.relayAddress} />
      <Example title={t.nginx} text={nginxExample(relayUrl)} />
      <Example title={t.caddy} text={caddyExample(relayUrl)} />
      <StaticNames domain={domain} api={api} />
    </div>
  )
}

function StaticNames({ domain, api }: { domain: Domain; api: Api }) {
  const t = useMessages()
  const [listed, setListed] = useState<[string, string][]>([])
  const [error, setError] = useState<string | null>(null)
  const names = { _smtp: domain.bridgePubkey, ...Object.fromEntries(listed) }

  // Read on each opening, so that the addresses changed meanwhile show.
  async function load() {
    if (!domain.verifiedAt) return
    setError(null)
    try {
      const { addresses } = await api.listAddresses(domain.domain)
      setListed(
        addresses
          .filter((address) => !address.private && address.enabled && NIP05_NAME.test(address.localPart))
          .map((address) => [address.localPart, address.pubkey]),
      )
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  return (
    <details onToggle={(event) => event.currentTarget.open && load()}>
      <summary className="w-fit cursor-pointer text-muted hover:text-ink">{t.nip05.withoutRelay}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted">{t.nip05.staticNote}</p>
        <Snippet text={JSON.stringify({ names }, null, 2)} label={t.nip05.names} />
        <ErrorText>{error}</ErrorText>
      </div>
    </details>
  )
}

function Example({ title, text }: { title: string; text: string }) {
  return (
    <details>
      <summary className="w-fit cursor-pointer text-muted hover:text-ink">{title}</summary>
      <div className="mt-2">
        <Snippet text={text} label={title} />
      </div>
    </details>
  )
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-rule bg-surface py-2 pr-2 pl-3">
      <pre className="min-w-0 overflow-x-auto py-0.5 font-mono text-xs leading-5">{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  )
}

// nginx sends no SNI to an https upstream by default, and the TLS handshake then fails.
function nginxExample(relayUrl: string): string {
  return `location = /.well-known/nostr.json {
    proxy_pass ${relayUrl};
    proxy_ssl_server_name on;
}`
}

// Caddy sets the upstream Host by itself since v2.11, header_up keeps older versions working.
function caddyExample(relayUrl: string): string {
  const { origin, pathname } = new URL(relayUrl)
  return `handle /.well-known/nostr.json {
\trewrite * ${pathname}
\treverse_proxy ${origin} {
\t\theader_up Host {upstream_hostport}
\t}
}`
}
