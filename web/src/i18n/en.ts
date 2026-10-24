const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const en = {
  language: 'English',
  exampleDomain: 'yourdomain.com',

  pages: {
    index: {
      title: 'Nostr Mail for your domain',
      description: 'Connect a domain you own and receive its email in Nostr Mail.',
    },
    dashboard: { title: 'Your domains on Nostr Mail', description: 'The domains you connected to Nostr Mail.' },
    connect: {
      title: 'Connect a domain to Nostr Mail',
      description: 'Connect a domain you own and receive its email in Nostr Mail.',
    },
    domain: {
      title: 'Domain on Nostr Mail',
      description: 'The addresses, DNS records and abuse reports of a domain connected to Nostr Mail.',
    },
    admin: { title: 'Nostr Mail admin', description: 'Every domain connected to this Nostr Mail server.' },
  },

  common: {
    signIn: 'Sign in',
    cancel: 'Cancel',
    yourDomains: 'Your domains',
    yourKey: 'your key',
    yourKeyAlwaysAvailable: 'your key, always available',
    deliveredTo: (to: string) => `Delivered to ${to}`,
    noReport: 'No report yet.',
    checked: (when: string) => `checked ${when}`,
    loading: 'Loading',
    saving: 'Saving',
    save: 'Save',
    remove: 'Remove',
    removing: 'Removing',
    domain: 'Domain',
  },

  copy: {
    action: 'Copy',
    done: 'Copied',
    failed: 'Copy failed',
    label: (what: string) => `Copy ${what}`,
  },

  landing: {
    title: 'Email at your own domain, delivered over Nostr.',
    intro:
      'Connect a domain you own. Mail sent to its addresses reaches Nostr keys in Nostr Mail, and you send from the domain too.',
    connect: 'Connect your domain',
    getApp: 'Get Nostr Mail',
    caption:
      "Your key always has its npub address. Add named ones for anyone, each pointing at their key. Every address is also its key's NIP-05 identifier.",
    how: 'How it works',
    steps: [
      {
        title: 'Sign in with your Nostr key',
        text: 'Use a browser extension or a bunker. The key you sign in with owns the domains you connect.',
      },
      {
        title: 'Connect a domain and publish its DNS records',
        text: 'The site lists each record to add at your DNS provider, then checks them for you.',
      },
      {
        title: 'Read and send its mail in Nostr Mail',
        text: 'Mail sent to the domain reaches its keys over Nostr. Mail you send from it leaves signed for the domain, so receivers trust it.',
      },
    ],
    source: 'Source code',
  },

  app: {
    subtitle: { domains: 'for your domain', admin: 'admin' },
    signIn: {
      domains: {
        title: 'Sign in with your Nostr key',
        intro: 'It owns the domains you connect: sign in with the same key to manage them later.',
      },
      admin: {
        title: 'Server admin',
        intro: 'Sign in with a key listed in ADMIN_PUBKEYS to see every domain connected to this server.',
      },
    },
    nav: 'Site',
    admin: 'Admin',
    addAccount: 'Add an account',
    addAccountIntro: 'Sign in with another key. The menu at the top of every page switches between your accounts.',
  },

  account: {
    methods: { extension: 'Extension', bunker: 'Remote signer', key: 'Secret key' },
    menu: 'Account',
    signedInAs: 'Signed in as',
    switchTo: 'Switch to',
    switching: 'Switching',
    signOut: 'Sign out',
    signingOut: 'Signing out',
  },

  signIn: {
    connecting: 'Connecting',
    unlocking: 'Unlocking',
    withExtension: 'Sign in with extension',
    waitingForExtension: 'Waiting for the extension',
    noExtension: 'No Nostr extension found in this browser.',
    signerApp: 'Or use a signer app',
    qrTitle: 'QR code to connect a signer app',
    scan: 'Scan it with Amber or another NIP-46 signer, then approve the connection.',
    openInApp: 'Open in a signer app',
    connectionLink: 'the connection link',
    hideQr: 'Hide QR code',
    showQr: 'Show QR code',
    credential: 'Or use a bunker or your secret key',
    credentialPlaceholder: 'bunker://..., name@domain, nsec1... or ncryptsec1...',
    passwordLabel: 'Password of the ncryptsec',
    password: 'Password',
    keyStays: 'The key stays in this browser and is never sent. Sign out to remove it.',
    approve: 'Your bunker asks you to approve this site.',
    openApproval: 'Open the approval page',
  },

  dashboard: {
    connect: 'Connect a domain',
    empty: 'No domain yet. Connect one you own to receive its mail in Nostr Mail.',
    abuseReports: (n: number) => count(n, 'abuse report'),
    quotas: {
      title: 'Your quotas on this server',
      addresses: (used: number, limit: number) => `${used} of ${count(limit, 'address', 'addresses')}, on every domain`,
      addressesPerHour: (limit: number) => `${count(limit, 'new address', 'new addresses')} an hour`,
      pendingDomains: (limit: number) => `${count(limit, 'domain')} waiting for verification at a time`,
      recipientsPerDay: (limit: number) => `${count(limit, 'recipient')} a day for each of your domains`,
      keysPerAddress: (limit: number) => `${count(Math.max(limit, 1), 'key')} per address`,
      more: 'Ask the admin of this server if you need more.',
    },
  },

  privateServer: {
    title: 'This server is private',
    text: 'Its admin chooses the keys that connect domains. Send them your npub to be added.',
    yourNpub: 'your npub',
  },

  connect: {
    title: 'Connect a domain',
    intro:
      'Type a domain you own. Mail sent to this address will reach you in Nostr Mail once its DNS records are published.',
    connecting: 'Connecting',
    submit: 'Connect domain',
  },

  domainStatus: {
    suspended: 'Suspended by the admin of this server',
    unchecked: 'Publish the DNS records, then check them',
    unverified: 'Waiting for the ownership record',
    noMx: 'Verified, waiting for the MX record',
    waitingForA: 'Receiving mail, waiting for the A record',
    waitingForNip05: 'Receiving mail, waiting for _smtp in your NIP-05',
    waitingForSending: 'Receiving mail, waiting for SPF and DKIM to send',
    ok: 'Sending and receiving mail',
  },

  record: {
    name: (type: string) => `${type} name`,
    value: (type: string) => `${type} value`,
    priority: (priority: number) => `Priority ${priority}`,
    found: 'Found:',
    status: { ok: 'Found', missing: 'Missing', mismatch: 'Different value', error: 'Lookup failed' },
    unchecked: 'Not checked',
    optional: 'Optional',
  },

  domainPage: {
    documentTitle: (domain: string) => `${domain} on Nostr Mail`,
    tabs: { addresses: 'Addresses', dns: 'DNS', abuse: 'Abuse reports', settings: 'Settings' },
    sections: (domain: string) => `Sections of ${domain}`,
    missing: 'This domain is not connected to your key.',
    suspended: (domain: string) =>
      `The domain no longer receives nor sends mail, and its addresses no longer resolve. Mail sent to abuse@${domain} still reaches you and the admins of this server. Ask them why the domain is suspended.`,
    catchAll: {
      title: 'Catch-all',
      label: (domain: string) => `Mail to any address on ${domain} creates it`,
      note: 'An address that does not exist yet, like shop@ or you+news@, is created for your key on its first mail, private, and shows in the list above. Once removed, it is not created again.',
      blocked: 'Close the domain to everyone first.',
    },
    shared: {
      title: 'Open to everyone',
      label: (domain: string) => `Anyone can create addresses on ${domain}`,
      note: 'Anyone who signs in on this site creates them for their own key, and they show in the list above, where you can remove them. Names like abuse, postmaster and support stay yours. Closing it again keeps the addresses already created.',
      blocked: 'Turn the catch-all off first.',
    },
    receive: {
      title: 'To receive mail',
      note: 'The MX record sends all mail for the domain here. Some DNS providers want only the part of the name before your domain, like _nostr-mail, and nothing for the domain itself.',
    },
    send: {
      title: 'To send mail',
      note: 'SPF and DKIM prove that mail from the domain really comes from it. If the domain already has an SPF record, add the include to it rather than publishing a second one.',
    },
    checking: 'Checking',
    check: 'Check DNS',
    abuse: (domain: string) =>
      `Mail sent to abuse@${domain}, newest first. The admins of this server get it too, and keep the reports you delete.`,
    remove: {
      title: 'Remove the domain',
      effect: (domain: string, verified: boolean) =>
        `${domain} stops receiving and sending mail${verified ? ', but mail to abuse@ still reaches the admins of this server.' : '.'}`,
      confirm: (domain: string) => `Remove ${domain}?`,
      button: 'Remove domain',
    },
  },

  addresses: {
    intro:
      'Mail sent to an address reaches the Nostr keys it points at, and each of them can send from it. Anyone can look up the key of a public address (NIP-05), while a private one keeps it hidden, as does one with several keys. A disabled address drops its mail without the sender knowing, and can still send.',
    createdBy: (key: string) => `${key}, who created it`,
    deleted: (n: number) => `Deleted addresses (${n})`,
    deletedNote:
      'Mail to them is refused, and nobody creates them again, neither by hand nor through the catch-all, until you allow them.',
    allowing: 'Allowing',
    allowAll: 'Allow them all',
    allowAgain: 'Allow again',
    allowAgainLabel: (address: string) => `Allow ${address} again`,
    private: 'Private',
    disabled: 'Disabled',
    makePublic: 'Make public',
    makePrivate: 'Make private',
    privacyLabel: (address: string, isPrivate: boolean) => `Make ${address} ${isPrivate ? 'public' : 'private'}`,
    enable: 'Enable',
    disable: 'Disable',
    stateLabel: (address: string, enabled: boolean) => `${enabled ? 'Disable' : 'Enable'} ${address}`,
    removeLabel: (address: string) => `Remove ${address}`,
    keys: 'Keys',
    keysLabel: (address: string) => `Change the keys of ${address}`,
    keysNote:
      'Every key gets the mail sent to the address and can send from it. With more than one, the address is private: NIP-05 shows a single key, so mail from Nostr apps has to come through this server to reach them all.',
    newKey: 'New key',
    addKey: 'Add key',
    removeKey: 'Remove',
    removingKey: 'Removing',
    removeKeyLabel: (npub: string, address: string) => `Remove ${npub} from ${address}`,
    newAddress: 'New address',
    namePlaceholder: 'name',
    deliveredTo: 'Delivered to',
    privateNote: 'Mail still arrives, but nobody can look up the key it reaches.',
    adding: 'Adding',
    add: 'Add address',
  },

  sharedAddresses: {
    title: 'Addresses on shared domains',
    intro:
      'Their owners let anyone create addresses that deliver to their own key. The owner of a domain can still remove any address on it.',
  },

  abuseReport: {
    noSubject: '(no subject)',
    from: (sender: string) => `From ${sender}`,
    emptySender: 'an empty sender',
    to: (domain: string) => `to abuse@${domain}`,
    hide: 'Hide message',
    show: 'Show message',
    download: 'Download .eml',
    confirm: 'Delete this report?',
    deleting: 'Deleting',
    delete: 'Delete',
    cutShort: 'Cut short here: download the .eml to read the rest.',
  },

  domainKey: {
    title: 'Domain key',
    intro: (domain: string) =>
      `Apps find this key as _smtp@${domain}. It writes the mail the domain receives and opens the mail it sends.`,
    publicKey: 'Public key',
    thePublicKey: 'the public key',
    inBunker: 'Secret key in your bunker',
    bunkerNote:
      'The server asks it to seal, sign and open the mail of the domain. While it does not answer, mail to the domain waits and mail from it is not sent.',
    hidden: 'Hidden',
    secretKey: 'Secret key. Whoever has it can read the mail sent from the domain.',
    theSecretKey: 'the secret key',
    hide: 'Hide',
    show: 'Show',
    ownKey: 'Use your own key',
    ownKeyNote: (domain: string, inBunker: boolean) =>
      `Paste the nsec of a key made for this domain only, or the bunker:// link of a bunker that holds it. The server opens every message sent to the key and replaces its relay lists. ${inBunker ? `Another key replaces the one in your bunker for ${domain}.` : `Another key replaces the current one for ${domain}, so save its nsec first if you need it.`}`,
    bunkerOnline: 'A bunker must stay online and answer this server without asking you each time.',
    placeholder: 'nsec1... or bunker://...',
    waitingForBunker: 'Waiting for your bunker',
    replacing: 'Replacing',
    submit: 'Use this key',
  },

  nip05: {
    title: 'For Nostr apps (NIP-05)',
    intro: (domain: string) =>
      `Nostr apps look up the addresses of ${domain}, and the _smtp key they send its mail through, at https://${domain}/.well-known/nostr.json.`,
    hosts: { server: 'This server, through an A record', owner: 'My own website' },
    hostLegend: (domain: string) => `Who serves NIP-05 for ${domain}`,
    serverAnswers: (domain: string) =>
      `This server answers there once the A record points here, in place of any website on ${domain}.`,
    relay:
      'Relay that path to this address with a proxy, not a redirect, which NIP-05 clients ignore. This server then answers for every address of the domain and keeps the private ones hidden.',
    relayAddress: 'relay address',
    nginx: 'nginx, in the server block of the domain',
    caddy: 'Caddy, in the site block of the domain',
    withoutRelay: 'Without a relay',
    staticNote:
      'Add these names to the file, served with Access-Control-Allow-Origin: *, and update it whenever an address changes. Private addresses, and those with several keys, stay out of it.',
    names: 'nostr.json names',
  },

  admin: {
    tabs: {
      domains: 'Domains',
      access: 'Access',
      quotas: 'Quotas',
      suspended: 'Suspended',
      abuse: 'Abuse',
      server: 'Server',
      settings: 'Settings',
    },
    sections: 'Sections of the admin',
    noDomain: 'No domain is connected yet.',
    summary: (connected: number, sending: number, suspended: number, addresses: number) =>
      `${count(connected, 'domain')} connected, ${sending} sending and receiving${suspended ? `, ${suspended} suspended` : ''}. ${count(addresses, 'named address', 'named addresses')}.`,
    connected: 'Connected',
    notVerified: 'Not verified',
    notVerifiedNote:
      'Claims whose ownership record was never found. The first key whose record is found owns the domain, the other claims are then dropped.',
    suspendedNote:
      'The server neither receives, sends nor serves NIP-05 for these domains, and no key can claim them. Their abuse@ still reaches you, with the other abuse reports.',
    noSuspension: 'No domain is suspended.',
    abuseNote:
      'Mail sent to abuse@ of the domains, newest first. Their owners get it too, and keep the reports you delete.',
    toFix: (n: number) => `${count(n, 'record')} to fix`,
    allFound: 'Every record found',
    serverNote:
      'Checked when the page loads. Connected domains point their MX at the name of the A record and include the name of the SPF record in their own. The PTR record is set at the hosting provider: receivers trust the mail this server sends when its address names it back. The server works over IPv4, so its name should have no AAAA record.',
    namedAddresses: (n: number) => count(n, 'named address', 'named addresses'),
    openToEveryone: 'open to everyone',
    claimed: (when: string) => `claimed ${when}`,
    suspendedSince: (when: string) => `Suspended ${when}`,
    noClaim: 'No key claims it.',
    verifiedWith: (addresses: number) => `verified, ${count(addresses, 'named address', 'named addresses')}`,
    unverified: 'not verified',
    lifting: 'Lifting',
    lift: 'Lift suspension',
    suspendConfirm: (domain: string) =>
      `Suspend ${domain}? It stops receiving and sending mail at once, whichever key claims it.`,
    suspending: 'Suspending',
    suspend: 'Suspend',
    suspendDomain: 'Suspend domain',
    ownerNpub: (domain: string) => `npub of the key that claims ${domain}`,
    lastCheck: 'DNS records at the last check',
    recordNames: { ownership: 'Ownership', mx: 'MX', nip05: 'NIP-05', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' },
    status: {
      ownershipNotFound: 'Ownership not found',
      neverChecked: 'Never checked',
      noMx: 'Verified, no MX record',
      receivingOnly: 'Receiving only',
      ok: 'Sending and receiving',
    },
    checks: { ok: 'found', missing: 'missing', mismatch: 'different value', error: 'lookup failed' },
  },

  allowedKeys: {
    registration: 'Who can connect a domain',
    closed: 'The admins and the allowed keys',
    open: 'Any Nostr key',
    title: 'Allowed keys',
    unused: 'Not used while any key can connect a domain.',
    removeNote: 'A key you remove keeps the domains it already connected: suspend them to stop them.',
    empty: 'No key is allowed yet.',
    allowed: (when: string, claims: number) => `Allowed ${when}, ${count(claims, 'domain')} claimed`,
    removeLabel: (npub: string) => `Remove ${npub}`,
    allowKey: 'Allow a key',
    allowing: 'Allowing',
    submit: 'Allow key',
  },

  quotas: {
    names: {
      addresses: 'Addresses per key',
      addressesPerHour: 'Addresses created per hour',
      pendingDomains: 'Domains waiting for verification',
      recipientsPerDay: 'Recipients per domain per day',
      keysPerAddress: 'Keys per address',
    },
    notes: {
      addresses:
        'Every address a key holds: on its own domains, those their catch-all created included, and on shared domains. Once a key reaches it, the catch-all of its domains creates no address and their mail is refused.',
      addressesPerHour: 'Over the last hour, deleted addresses included.',
      pendingDomains:
        'Domains a key connected whose ownership record is not found yet. Each one costs the server a DKIM key.',
      recipientsPerDay: 'Over the last 24 hours, whoever sends from the domain. A mail that would go over is not sent.',
      keysPerAddress:
        'The keys one address delivers to. One is always allowed, and an address keeps its keys when the quota goes down.',
    },
    serverTitle: 'Quotas of the server',
    serverNote: 'Every key gets them, except the admins, who have none. An empty field is no limit.',
    noLimit: 'No limit',
    unlimited: 'no limit',
    keysTitle: 'Keys with quotas of their own',
    keysNote: "They get these quotas instead of the server's, and the server's for the others.",
    keysEmpty: 'No key has quotas of its own.',
    giveKey: 'Give a key quotas of its own',
    key: 'Key',
    fieldsNote: "An empty field keeps the server's quota.",
    server: (value: string) => `Server: ${value}`,
    item: (name: string, value: string) => `${name}: ${value}`,
    change: 'Change',
    changeLabel: (npub: string) => `Change the quotas of ${npub}`,
    removeLabel: (npub: string) => `Give ${npub} the quotas of the server back`,
  },

  settings: {
    size: {
      title: 'Largest message',
      note: 'Mail over this size is refused when it arrives, and is not sent when a client hands it over.',
      label: 'Largest message, in MB',
      unit: 'MB',
    },
    blossom: {
      title: 'Blossom servers',
      note: "Given to new domains for the mail too large for a gift wrap, and used by the server's own key. Connected domains keep theirs.",
    },
    domainRelays: {
      title: 'Domain relays',
      note: 'Every domain key announces them, and the mail to send reaches the server there. Saving publishes the lists of every domain key again. The server keeps listening to a removed relay for seven days, for the clients that have not seen the change.',
    },
    indexerRelays: {
      title: 'Indexer relays',
      note: 'Where the server looks up the relays and Blossom servers of other keys. Domain keys publish their lists there too.',
    },
    onePerLine: (title: string) => `${title}, one per line`,
  },

  errors: {
    codes: {
      invalid_domain: 'Enter a domain name, like example.com.',
      domain_not_found: 'This domain is no longer connected to your key. Reload the page.',
      domain_not_verified: 'Verify the domain before adding addresses.',
      invalid_local_part: 'Use letters, digits, dots, hyphens and underscores, 64 characters at most.',
      reserved_local_part: 'This name is reserved.',
      invalid_pubkey: 'Enter an npub or a hex public key.',
      invalid_pubkeys: 'Enter an npub or a hex public key.',
      address_not_found: 'This address no longer exists. Reload the page.',
      address_taken: 'This address is taken. Pick another name.',
      address_deleted: 'This address was deleted. Its domain owner has to allow it again before anyone creates it.',
      deleted_address_not_found: 'This address is no longer deleted. Reload the page.',
      domain_not_shared: 'This domain no longer lets anyone create addresses. Reload the page.',
      invalid_shared: 'The server did not understand this change. Reload the page.',
      invalid_catch_all: 'The server did not understand this change. Reload the page.',
      domain_shared: 'Anyone can create addresses on this domain. Close it to everyone first.',
      domain_catch_all: 'The catch-all is on. Turn it off first.',
      invalid_nsec: 'Enter a secret key starting with nsec1.',
      owner_key: 'This is the key you signed in with. Use a key made for this domain only.',
      key_in_use: 'Another domain already uses this key.',
      key_in_bunker: 'This key is in your bunker: the server has no nsec to show.',
      invalid_bunker_url: 'Enter a bunker:// link with at least one wss:// relay.',
      bunker_refused: 'Your bunker refused. Let this server sign and encrypt with NIP-44 without asking you.',
      bunker_auth_url:
        'Your bunker asks for an approval in a browser. Paste a bunker:// link that includes its secret.',
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
      invalid_quotas: 'Enter whole numbers, or leave a field empty.',
      key_quotas_not_found: 'This key no longer has quotas of its own. Reload the page.',
      pending_domain_quota:
        'You have as many domains waiting for verification as this server allows. Verify or remove one first.',
      address_quota: 'You have as many addresses as this server allows. Remove one first, or ask its admin for more.',
      address_rate_quota: 'You created as many addresses as this server allows in an hour. Try again later.',
      keys_per_address_quota:
        'This address has as many keys as this server allows. Remove one first, or ask its admin for more.',
      no_extension: 'No Nostr extension found in this browser.',
      invalid_bunker: 'Enter a bunker:// link, the name@domain of your bunker, an nsec or an ncryptsec.',
      bunker_timeout: 'Your bunker did not answer in time.',
      nostr_connect_closed: 'The relays closed the connection. Show the QR code again.',
      invalid_secret_key: 'Enter a secret key starting with nsec1 or ncryptsec1.',
      wrong_password: 'This password does not open this ncryptsec.',
      account_signed_out: 'This account was signed out in another tab. Sign in with it again.',
    },
    signatureRefused: (code: string) => `The server refused the signature (${code}).`,
    status: (status: number, code: string) => `The server answered ${status} (${code}).`,
    unreachable: 'Could not reach the server.',
  },
}

export type Messages = typeof en

export default en
