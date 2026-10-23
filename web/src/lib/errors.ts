import { ApiError } from './api'

const MESSAGES: Record<string, string> = {
  invalid_domain: 'Enter a domain name, like example.com.',
  domain_not_found: 'This domain is no longer connected to your key. Reload the page.',
  domain_not_verified: 'Verify the domain before adding addresses.',
  invalid_local_part: 'Use letters, digits, dots, hyphens and underscores, 64 characters at most.',
  reserved_local_part: 'This name is reserved.',
  invalid_pubkey: 'Enter an npub or a hex public key.',
  address_not_found: 'This address no longer exists. Reload the page.',
  invalid_nsec: 'Enter a secret key starting with nsec1.',
  owner_key: 'This is the key you signed in with. Use a key made for this domain only.',
  key_in_use: 'Another domain already uses this key.',
  key_in_bunker: 'This key is in your bunker: the server has no nsec to show.',
  invalid_bunker_url: 'Enter a bunker:// link with at least one wss:// relay.',
  bunker_refused: 'Your bunker refused. Let this server sign and encrypt with NIP-44 without asking you.',
  bunker_auth_url: 'Your bunker asks for an approval in a browser. Paste a bunker:// link that includes its secret.',
  not_admin: 'This key is not an admin of this server. Add its npub to ADMIN_PUBKEYS.',
  domain_suspended: 'The admin of this server suspended this domain.',
  suspension_not_found: 'This domain is no longer suspended. Reload the page.',
  not_allowed: 'This server is private: its admin chooses the keys that connect domains.',
  allowed_key_not_found: 'This key is no longer allowed. Reload the page.',
  abuse_report_not_found: 'This report no longer exists. Reload the page.',
  invalid_max_message_bytes: 'Enter a size between 1 and 1024 MB.',
  invalid_blossom_servers: 'Enter at least one https:// URL of a public server, one per line.',
  invalid_domain_relays: 'Enter at least one wss:// URL of a public relay, one per line.',
  invalid_indexer_relays: 'Enter at least one wss:// URL of a public relay, one per line.',
  no_extension: 'No Nostr extension found in this browser.',
  invalid_bunker: 'Enter a bunker:// link, the name@domain of your bunker, an nsec or an ncryptsec.',
  bunker_timeout: 'Your bunker did not answer in time.',
  nostr_connect_closed: 'The relays closed the connection. Show the QR code again.',
  invalid_secret_key: 'Enter a secret key starting with nsec1 or ncryptsec1.',
  wrong_password: 'This password does not open this ncryptsec.',
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
