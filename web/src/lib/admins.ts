// The keys that opened the admin page in this browser, so that the other pages
// link to it without asking the server.
const ADMINS_KEY = 'nostr-mail.admins'

export function isKnownAdmin(pubkey: string): boolean {
  return load().includes(pubkey)
}

export function rememberAdmin(pubkey: string, admin: boolean): void {
  const others = load().filter((other) => other !== pubkey)
  try {
    localStorage.setItem(ADMINS_KEY, JSON.stringify(admin ? [...others, pubkey] : others))
  } catch {}
}

function load(): string[] {
  try {
    const admins = JSON.parse(localStorage.getItem(ADMINS_KEY) ?? '[]')
    return Array.isArray(admins) ? admins : []
  } catch {
    return []
  }
}
