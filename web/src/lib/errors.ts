import { ApiError } from './api'

const MESSAGES: Record<string, string> = {
  invalid_domain: 'Enter a domain name, like example.com.',
  domain_not_found: 'This domain is no longer connected to your key. Reload the page.',
  domain_not_verified: 'Verify the domain before adding addresses.',
  invalid_local_part: 'Use letters, digits, dots, hyphens and underscores, 64 characters at most.',
  reserved_local_part: 'This name is reserved.',
  invalid_pubkey: 'Enter an npub or a hex public key.',
  address_not_found: 'This address no longer exists. Reload the page.',
  not_admin: 'This key is not an admin of this server. Add its npub to ADMIN_PUBKEYS.',
  domain_suspended: 'The admin of this server suspended this domain.',
  suspension_not_found: 'This domain is no longer suspended. Reload the page.',
  no_extension: 'No Nostr extension found in this browser.',
  invalid_bunker: 'Enter a bunker:// link or the name@domain of your bunker.',
  bunker_timeout: 'Your bunker did not answer in time.',
}

export function describeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (MESSAGES[code]) return MESSAGES[code]
  if (error instanceof ApiError) {
    return error.status === 401
      ? `The server refused the signature (${error.code}).`
      : `The server answered ${error.status} (${error.code}).`
  }
  // fetch rejects with a TypeError when the request does not get through.
  if (error instanceof TypeError) return 'Could not reach the server.'

  return code
}
