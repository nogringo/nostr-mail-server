import { useState } from 'react'
import type { Api, Domain, Nip05Host } from '../lib/api'
import { describeError } from '../lib/errors'
import RecordRow from './RecordRow'
import { CopyButton, ErrorText } from './ui'

const HOSTS: [Nip05Host, string][] = [
  ['server', 'This server, through an A record'],
  ['owner', 'My own website'],
]

export default function Nip05Group({
  domain,
  api,
  onChange,
}: {
  domain: Domain
  api: Api
  onChange: (domain: Domain) => void
}) {
  const record = domain.records.find(({ id }) => id === 'nip05')

  return (
    <div>
      <h2 className="font-medium">For Nostr apps (NIP-05)</h2>
      <p className="mt-1 text-muted text-sm">
        Nostr apps look up the addresses of {domain.domain}, and the _smtp key they send its mail through, at https://
        {domain.domain}/.well-known/nostr.json.
      </p>
      <HostChoice domain={domain} api={api} onChange={onChange} />
      {domain.nip05 === 'server' ? (
        <p className="mt-3 text-muted text-sm">
          This server answers there once the A record points here, in place of any website on {domain.domain}.
        </p>
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
  const [pending, setPending] = useState<Nip05Host | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(nip05: Nip05Host) {
    setPending(nip05)
    setError(null)
    try {
      onChange(await api.setNip05Host(domain.domain, nip05))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setPending(null)
    }
  }

  return (
    <fieldset disabled={pending !== null} className="mt-3">
      <legend className="sr-only">Who serves NIP-05 for {domain.domain}</legend>
      <div className="space-y-1.5 text-sm">
        {HOSTS.map(([value, label]) => (
          <label key={value} className="flex w-fit cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="nip05"
              checked={(pending ?? domain.nip05) === value}
              onChange={() => choose(value)}
              className="accent-accent"
            />
            {label}
          </label>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </fieldset>
  )
}

function Relay({ domain, api }: { domain: Domain; api: Api }) {
  const relayUrl = `${window.location.origin}/nip05/${domain.domain}`

  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted">
        Relay that path to this address with a proxy, not a redirect, which NIP-05 clients ignore. This server then
        answers for every address of the domain and keeps the private ones hidden.
      </p>
      <Snippet text={relayUrl} label="relay address" />
      <Example title="nginx, in the server block of the domain" text={nginxExample(relayUrl)} />
      <Example title="Caddy, in the site block of the domain" text={caddyExample(relayUrl)} />
      <StaticNames domain={domain} api={api} />
    </div>
  )
}

function StaticNames({ domain, api }: { domain: Domain; api: Api }) {
  const [listed, setListed] = useState<[string, string][]>([])
  const [error, setError] = useState<string | null>(null)
  const names = { _smtp: domain.bridgePubkey, ...Object.fromEntries(listed) }

  // Read on each opening, so that the addresses changed meanwhile show.
  async function load() {
    if (!domain.verifiedAt) return
    setError(null)
    try {
      const addresses = await api.listAddresses(domain.domain)
      setListed(addresses.filter((address) => !address.private).map((address) => [address.localPart, address.pubkey]))
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  return (
    <details onToggle={(event) => event.currentTarget.open && load()}>
      <summary className="w-fit cursor-pointer text-muted hover:text-ink">Without a relay</summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted">
          Add these names to the file, served with Access-Control-Allow-Origin: *, and update it whenever an address
          changes. Private addresses stay out of it.
        </p>
        <Snippet text={JSON.stringify({ names }, null, 2)} label="nostr.json names" />
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
