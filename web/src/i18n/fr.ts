import type { Messages } from './en'

// French puts 0 in the singular too.
const count = (n: number, one: string, many: string) => `${n} ${n < 2 ? one : many}`

const fr: Messages = {
  language: 'Français',
  exampleDomain: 'votredomaine.com',

  pages: {
    index: {
      title: 'Nostr Mail pour votre domaine',
      description: 'Connectez un domaine qui vous appartient et recevez ses e-mails dans Nostr Mail.',
    },
    dashboard: {
      title: 'Vos domaines sur Nostr Mail',
      description: 'Les domaines que vous avez connectés à Nostr Mail.',
    },
    connect: {
      title: 'Connecter un domaine à Nostr Mail',
      description: 'Connectez un domaine qui vous appartient et recevez ses e-mails dans Nostr Mail.',
    },
    domain: {
      title: 'Domaine sur Nostr Mail',
      description:
        "Les adresses, les enregistrements DNS et les signalements d'abus d'un domaine connecté à Nostr Mail.",
    },
    admin: { title: 'Admin de Nostr Mail', description: 'Tous les domaines connectés à ce serveur Nostr Mail.' },
  },

  common: {
    signIn: 'Se connecter',
    cancel: 'Annuler',
    yourDomains: 'Vos domaines',
    yourKey: 'votre clé',
    yourKeyAlwaysAvailable: 'votre clé, toujours disponible',
    deliveredTo: (to: string) => `Distribué à ${to}`,
    noReport: "Aucun signalement pour l'instant.",
    checked: (when: string) => `vérifié ${when}`,
    loading: 'Chargement',
    saving: 'Enregistrement',
    save: 'Enregistrer',
    remove: 'Supprimer',
    removing: 'Suppression',
    domain: 'Domaine',
  },

  copy: {
    action: 'Copier',
    done: 'Copié',
    failed: 'Échec de la copie',
    label: (what: string) => `Copier ${what}`,
  },

  landing: {
    title: 'Des e-mails sur votre propre domaine, livrés via Nostr.',
    intro:
      'Connectez un domaine qui vous appartient. Les e-mails envoyés à ses adresses arrivent à des clés Nostr dans Nostr Mail, et vous envoyez aussi depuis le domaine.',
    connect: 'Connecter votre domaine',
    getApp: 'Obtenir Nostr Mail',
    caption:
      "Votre clé a toujours son adresse npub. Ajoutez des adresses nommées pour qui vous voulez, chacune pointant vers sa clé. Chaque adresse est aussi l'identifiant NIP-05 de sa clé.",
    how: 'Comment ça marche',
    steps: [
      {
        title: 'Connectez-vous avec votre clé Nostr',
        text: 'Utilisez une extension de navigateur ou un bunker. La clé utilisée pour vous connecter possède les domaines que vous connectez.',
      },
      {
        title: 'Connectez un domaine et publiez ses enregistrements DNS',
        text: 'Le site liste chaque enregistrement à ajouter chez votre fournisseur DNS, puis les vérifie pour vous.',
      },
      {
        title: 'Lisez et envoyez ses e-mails dans Nostr Mail',
        text: 'Les e-mails envoyés au domaine arrivent à ses clés via Nostr. Ceux que vous en envoyez partent signés pour le domaine, et les destinataires leur font donc confiance.',
      },
    ],
    source: 'Code source',
  },

  app: {
    subtitle: { domains: 'pour votre domaine', admin: 'admin' },
    signIn: {
      domains: {
        title: 'Connectez-vous avec votre clé Nostr',
        intro:
          'Elle possède les domaines que vous connectez : reconnectez-vous avec la même clé pour les gérer plus tard.',
      },
      admin: {
        title: 'Admin du serveur',
        intro:
          'Connectez-vous avec une clé listée dans ADMIN_PUBKEYS pour voir tous les domaines connectés à ce serveur.',
      },
    },
    nav: 'Site',
    admin: 'Admin',
    addAccount: 'Ajouter un compte',
    addAccountIntro: "Connectez-vous avec une autre clé. Le menu en haut de chaque page passe d'un compte à l'autre.",
  },

  account: {
    methods: { extension: 'Extension', bunker: 'Signataire distant', key: 'Clé secrète' },
    menu: 'Compte',
    signedInAs: 'Compte connecté',
    switchTo: 'Passer à',
    switching: 'Changement',
    signOut: 'Se déconnecter',
    signingOut: 'Déconnexion',
  },

  signIn: {
    connecting: 'Connexion',
    unlocking: 'Déverrouillage',
    withExtension: "Se connecter avec l'extension",
    waitingForExtension: "En attente de l'extension",
    noExtension: 'Aucune extension Nostr trouvée dans ce navigateur.',
    signerApp: 'Ou utilisez une app de signature',
    qrTitle: 'QR code pour connecter une app de signature',
    scan: 'Scannez-le avec Amber ou un autre signataire NIP-46, puis approuvez la connexion.',
    openInApp: 'Ouvrir dans une app de signature',
    connectionLink: 'le lien de connexion',
    hideQr: 'Masquer le QR code',
    showQr: 'Afficher le QR code',
    credential: 'Ou utilisez un bunker ou votre clé secrète',
    credentialPlaceholder: 'bunker://..., nom@domaine, nsec1... ou ncryptsec1...',
    passwordLabel: 'Mot de passe du ncryptsec',
    password: 'Mot de passe',
    keyStays: "La clé reste dans ce navigateur et n'est jamais envoyée. Déconnectez-vous pour l'effacer.",
    approve: "Votre bunker vous demande d'approuver ce site.",
    openApproval: "Ouvrir la page d'approbation",
  },

  dashboard: {
    connect: 'Connecter un domaine',
    empty:
      "Aucun domaine pour l'instant. Connectez-en un qui vous appartient pour recevoir ses e-mails dans Nostr Mail.",
    abuseReports: (n: number) => count(n, "signalement d'abus", "signalements d'abus"),
    quotas: {
      title: 'Vos quotas sur ce serveur',
      addresses: (used: number, limit: number) =>
        `${used} sur ${count(limit, 'adresse', 'adresses')}, tous domaines confondus`,
      addressesPerHour: (limit: number) => `${count(limit, 'nouvelle adresse', 'nouvelles adresses')} par heure`,
      pendingDomains: (limit: number) => `${count(limit, 'domaine', 'domaines')} en attente de vérification à la fois`,
      recipientsPerDay: (limit: number) =>
        `${count(limit, 'destinataire', 'destinataires')} par jour pour chacun de vos domaines`,
      keysPerAddress: (limit: number) => `${count(Math.max(limit, 1), 'clé', 'clés')} par adresse`,
      more: "Demandez à l'admin de ce serveur si vous avez besoin de plus.",
    },
  },

  privateServer: {
    title: 'Ce serveur est privé',
    text: 'Son admin choisit les clés qui connectent des domaines. Envoyez-lui votre npub pour que votre clé soit ajoutée.',
    yourNpub: 'votre npub',
  },

  connect: {
    title: 'Connecter un domaine',
    intro:
      'Saisissez un domaine qui vous appartient. Les e-mails envoyés à cette adresse vous parviendront dans Nostr Mail une fois ses enregistrements DNS publiés.',
    connecting: 'Connexion',
    submit: 'Connecter le domaine',
  },

  domainStatus: {
    suspended: "Suspendu par l'admin de ce serveur",
    unchecked: 'Publiez les enregistrements DNS, puis vérifiez-les',
    unverified: "En attente de l'enregistrement de propriété",
    noMx: "Vérifié, en attente de l'enregistrement MX",
    waitingForA: "Reçoit les e-mails, en attente de l'enregistrement A",
    waitingForNip05: 'Reçoit les e-mails, en attente de _smtp dans votre NIP-05',
    waitingForSending: 'Reçoit les e-mails, en attente de SPF et DKIM pour envoyer',
    ok: 'Envoie et reçoit les e-mails',
  },

  record: {
    name: (type: string) => `le nom ${type}`,
    value: (type: string) => `la valeur ${type}`,
    priority: (priority: number) => `Priorité ${priority}`,
    found: 'Trouvé :',
    status: { ok: 'Trouvé', missing: 'Absent', mismatch: 'Valeur différente', error: 'Échec de la recherche' },
    unchecked: 'Non vérifié',
    optional: 'Facultatif',
  },

  domainPage: {
    documentTitle: (domain: string) => `${domain} sur Nostr Mail`,
    tabs: { addresses: 'Adresses', dns: 'DNS', abuse: "Signalements d'abus", settings: 'Paramètres' },
    sections: (domain: string) => `Sections de ${domain}`,
    missing: "Ce domaine n'est pas connecté à votre clé.",
    suspended: (domain: string) =>
      `Le domaine ne reçoit ni n'envoie plus d'e-mails, et ses adresses ne se résolvent plus. Les e-mails envoyés à abuse@${domain} vous parviennent toujours, ainsi qu'aux admins de ce serveur. Demandez-leur pourquoi le domaine est suspendu.`,
    catchAll: {
      title: 'Catch-all',
      label: (domain: string) => `Un e-mail à n'importe quelle adresse de ${domain} la crée`,
      note: "Une adresse qui n'existe pas encore, comme boutique@ ou vous+infos@, est créée pour votre clé à son premier e-mail, privée, et apparaît dans la liste ci-dessus. Une fois supprimée, elle n'est plus recréée.",
      blocked: "Fermez d'abord le domaine à tous.",
    },
    shared: {
      title: 'Ouvert à tous',
      label: (domain: string) => `Tout le monde peut créer des adresses sur ${domain}`,
      note: 'Toute personne connectée à ce site les crée pour sa propre clé, et elles apparaissent dans la liste ci-dessus, où vous pouvez les supprimer. Les noms comme abuse, postmaster et support restent à vous. Le refermer garde les adresses déjà créées.',
      blocked: "Désactivez d'abord le catch-all.",
    },
    receive: {
      title: 'Pour recevoir des e-mails',
      note: "L'enregistrement MX envoie ici tous les e-mails du domaine. Certains fournisseurs DNS ne veulent que la partie du nom avant votre domaine, comme _nostr-mail, et rien pour le domaine lui-même.",
    },
    send: {
      title: 'Pour envoyer des e-mails',
      note: "SPF et DKIM prouvent que les e-mails du domaine viennent bien de lui. Si le domaine a déjà un enregistrement SPF, ajoutez-y l'include plutôt que d'en publier un second.",
    },
    checking: 'Vérification',
    check: 'Vérifier le DNS',
    abuse: (domain: string) =>
      `Les e-mails envoyés à abuse@${domain}, du plus récent au plus ancien. Les admins de ce serveur les reçoivent aussi, et gardent les signalements que vous supprimez.`,
    remove: {
      title: 'Retirer le domaine',
      effect: (domain: string, verified: boolean) =>
        `${domain} cesse de recevoir et d'envoyer des e-mails${verified ? ', mais les e-mails à abuse@ parviennent toujours aux admins de ce serveur.' : '.'}`,
      confirm: (domain: string) => `Retirer ${domain} ?`,
      button: 'Retirer le domaine',
    },
  },

  addresses: {
    intro:
      "Les e-mails envoyés à une adresse arrivent aux clés Nostr vers lesquelles elle pointe, et chacune peut envoyer depuis l'adresse. Tout le monde peut retrouver la clé d'une adresse publique (NIP-05), alors qu'une adresse privée la garde cachée, tout comme une adresse à plusieurs clés. Une adresse désactivée jette ses e-mails sans que l'expéditeur le sache, et peut toujours envoyer.",
    createdBy: (key: string) => `${key}, qui l'a créée`,
    deleted: (n: number) => `Adresses supprimées (${n})`,
    deletedNote:
      'Les e-mails qui leur sont adressés sont refusés, et personne ne les recrée, ni à la main ni par le catch-all, tant que vous ne les autorisez pas.',
    allowing: 'Autorisation',
    allowAll: 'Toutes les autoriser',
    allowAgain: 'Autoriser à nouveau',
    allowAgainLabel: (address: string) => `Autoriser à nouveau ${address}`,
    private: 'Privée',
    disabled: 'Désactivée',
    makePublic: 'Rendre publique',
    makePrivate: 'Rendre privée',
    privacyLabel: (address: string, isPrivate: boolean) => `Rendre ${address} ${isPrivate ? 'publique' : 'privée'}`,
    enable: 'Activer',
    disable: 'Désactiver',
    stateLabel: (address: string, enabled: boolean) => `${enabled ? 'Désactiver' : 'Activer'} ${address}`,
    removeLabel: (address: string) => `Supprimer ${address}`,
    keys: 'Clés',
    keysLabel: (address: string) => `Modifier les clés de ${address}`,
    keysNote:
      "Chaque clé reçoit les e-mails envoyés à l'adresse et peut envoyer depuis celle-ci. Avec plus d'une clé, l'adresse est privée : le NIP-05 ne montre qu'une seule clé, donc les e-mails des apps Nostr doivent passer par ce serveur pour les atteindre toutes.",
    newKey: 'Nouvelle clé',
    addKey: 'Ajouter la clé',
    removeKey: 'Retirer',
    removingKey: 'Retrait',
    removeKeyLabel: (npub: string, address: string) => `Retirer ${npub} de ${address}`,
    newAddress: 'Nouvelle adresse',
    namePlaceholder: 'nom',
    deliveredTo: 'Distribué à',
    privateNote: 'Les e-mails arrivent toujours, mais personne ne peut retrouver la clé qui les reçoit.',
    adding: 'Ajout',
    add: "Ajouter l'adresse",
  },

  sharedAddresses: {
    title: 'Adresses sur des domaines partagés',
    intro:
      "Leurs propriétaires permettent à chacun d'y créer des adresses distribuées à sa propre clé. Le propriétaire d'un domaine peut toujours supprimer n'importe laquelle de ses adresses.",
  },

  abuseReport: {
    noSubject: '(sans objet)',
    from: (sender: string) => `De ${sender}`,
    emptySender: 'un expéditeur vide',
    to: (domain: string) => `à abuse@${domain}`,
    hide: 'Masquer le message',
    show: 'Afficher le message',
    download: 'Télécharger le .eml',
    confirm: 'Supprimer ce signalement ?',
    deleting: 'Suppression',
    delete: 'Supprimer',
    cutShort: 'Coupé ici : téléchargez le .eml pour lire la suite.',
  },

  domainKey: {
    title: 'Clé du domaine',
    intro: (domain: string) =>
      `Les apps trouvent cette clé sous _smtp@${domain}. Elle écrit les e-mails que le domaine reçoit et ouvre ceux qu'il envoie.`,
    publicKey: 'Clé publique',
    thePublicKey: 'la clé publique',
    inBunker: 'Clé secrète dans votre bunker',
    bunkerNote:
      "Le serveur lui demande de sceller, signer et ouvrir les e-mails du domaine. Tant qu'il ne répond pas, les e-mails vers le domaine attendent et ceux qui en partent ne sont pas envoyés.",
    hidden: 'Masquée',
    secretKey: 'Clé secrète. Quiconque la possède peut lire les e-mails envoyés depuis le domaine.',
    theSecretKey: 'la clé secrète',
    hide: 'Masquer',
    show: 'Afficher',
    ownKey: 'Utiliser votre propre clé',
    ownKeyNote: (domain: string, inBunker: boolean) =>
      `Collez le nsec d'une clé créée pour ce domaine seulement, ou le lien bunker:// d'un bunker qui la détient. Le serveur ouvre chaque message envoyé à la clé et remplace ses listes de relais. ${inBunker ? `Une autre clé remplace celle de votre bunker pour ${domain}.` : `Une autre clé remplace l'actuelle pour ${domain}, alors enregistrez d'abord son nsec si vous en avez besoin.`}`,
    bunkerOnline: 'Un bunker doit rester en ligne et répondre à ce serveur sans vous demander à chaque fois.',
    placeholder: 'nsec1... ou bunker://...',
    waitingForBunker: 'En attente de votre bunker',
    replacing: 'Remplacement',
    submit: 'Utiliser cette clé',
  },

  nip05: {
    title: 'Pour les apps Nostr (NIP-05)',
    intro: (domain: string) =>
      `Les apps Nostr cherchent les adresses de ${domain}, et la clé _smtp par laquelle elles envoient ses e-mails, à https://${domain}/.well-known/nostr.json.`,
    hosts: { server: 'Ce serveur, via un enregistrement A', owner: 'Mon propre site web' },
    hostLegend: (domain: string) => `Qui sert le NIP-05 de ${domain}`,
    serverAnswers: (domain: string) =>
      `Ce serveur y répond une fois que l'enregistrement A pointe ici, à la place de tout site web sur ${domain}.`,
    relay:
      'Relayez ce chemin vers cette adresse avec un proxy, pas une redirection, que les clients NIP-05 ignorent. Ce serveur répond alors pour chaque adresse du domaine et garde les privées cachées.',
    relayAddress: "l'adresse du relais",
    nginx: 'nginx, dans le bloc server du domaine',
    caddy: 'Caddy, dans le bloc du site du domaine',
    withoutRelay: 'Sans relais',
    staticNote:
      "Ajoutez ces noms au fichier, servi avec Access-Control-Allow-Origin: *, et mettez-le à jour à chaque changement d'adresse. Les adresses privées, et celles à plusieurs clés, n'y figurent pas.",
    names: 'les noms de nostr.json',
  },

  admin: {
    tabs: {
      domains: 'Domaines',
      access: 'Accès',
      quotas: 'Quotas',
      suspended: 'Suspendus',
      abuse: 'Abus',
      server: 'Serveur',
      settings: 'Paramètres',
    },
    sections: "Sections de l'admin",
    noDomain: "Aucun domaine n'est connecté pour l'instant.",
    summary: (connected: number, sending: number, suspended: number, addresses: number) =>
      `${count(connected, 'domaine connecté', 'domaines connectés')}, ${sending} en envoi et réception${suspended ? `, ${count(suspended, 'suspendu', 'suspendus')}` : ''}. ${count(addresses, 'adresse nommée', 'adresses nommées')}.`,
    connected: 'Connectés',
    notVerified: 'Non vérifiés',
    notVerifiedNote:
      "Des revendications dont l'enregistrement de propriété n'a jamais été trouvé. La première clé dont l'enregistrement est trouvé possède le domaine, et les autres revendications sont alors abandonnées.",
    suspendedNote:
      "Le serveur ne reçoit, n'envoie ni ne sert de NIP-05 pour ces domaines, et aucune clé ne peut les revendiquer. Leur abuse@ vous parvient toujours, avec les autres signalements d'abus.",
    noSuspension: "Aucun domaine n'est suspendu.",
    abuseNote:
      'Les e-mails envoyés à abuse@ des domaines, du plus récent au plus ancien. Leurs propriétaires les reçoivent aussi, et gardent les signalements que vous supprimez.',
    toFix: (n: number) => count(n, 'enregistrement à corriger', 'enregistrements à corriger'),
    allFound: 'Tous les enregistrements trouvés',
    serverNote:
      "Vérifiés au chargement de la page. Les domaines connectés pointent leur MX vers le nom de l'enregistrement A et incluent le nom de l'enregistrement SPF dans le leur. L'enregistrement PTR se règle chez l'hébergeur : les destinataires font confiance aux e-mails que ce serveur envoie quand son adresse le nomme en retour. Le serveur fonctionne en IPv4, son nom ne doit donc avoir aucun enregistrement AAAA.",
    namedAddresses: (n: number) => count(n, 'adresse nommée', 'adresses nommées'),
    openToEveryone: 'ouvert à tous',
    claimed: (when: string) => `revendiqué ${when}`,
    suspendedSince: (when: string) => `Suspendu ${when}`,
    noClaim: 'Aucune clé ne le revendique.',
    verifiedWith: (addresses: number) => `vérifié, ${count(addresses, 'adresse nommée', 'adresses nommées')}`,
    unverified: 'non vérifié',
    lifting: 'Levée',
    lift: 'Lever la suspension',
    suspendConfirm: (domain: string) =>
      `Suspendre ${domain} ? Il cesse aussitôt de recevoir et d'envoyer des e-mails, quelle que soit la clé qui le revendique.`,
    suspending: 'Suspension',
    suspend: 'Suspendre',
    suspendDomain: 'Suspendre le domaine',
    ownerNpub: (domain: string) => `le npub de la clé qui revendique ${domain}`,
    lastCheck: 'Enregistrements DNS à la dernière vérification',
    recordNames: { ownership: 'Propriété', mx: 'MX', nip05: 'NIP-05', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' },
    status: {
      ownershipNotFound: 'Propriété non trouvée',
      neverChecked: 'Jamais vérifié',
      noMx: 'Vérifié, sans enregistrement MX',
      receivingOnly: 'Réception seulement',
      ok: 'Envoi et réception',
    },
    checks: { ok: 'trouvé', missing: 'absent', mismatch: 'valeur différente', error: 'échec de la recherche' },
  },

  allowedKeys: {
    registration: 'Qui peut connecter un domaine',
    closed: 'Les admins et les clés autorisées',
    open: "N'importe quelle clé Nostr",
    title: 'Clés autorisées',
    unused: "Inutilisées tant que n'importe quelle clé peut connecter un domaine.",
    removeNote:
      "Une clé que vous retirez garde les domaines qu'elle a déjà connectés : suspendez-les pour les arrêter.",
    empty: "Aucune clé n'est autorisée pour l'instant.",
    allowed: (when: string, claims: number) =>
      `Autorisée ${when}, ${count(claims, 'domaine revendiqué', 'domaines revendiqués')}`,
    removeLabel: (npub: string) => `Retirer ${npub}`,
    allowKey: 'Autoriser une clé',
    allowing: 'Autorisation',
    submit: 'Autoriser la clé',
  },

  quotas: {
    names: {
      addresses: 'Adresses par clé',
      addressesPerHour: 'Adresses créées par heure',
      pendingDomains: 'Domaines en attente de vérification',
      recipientsPerDay: 'Destinataires par domaine et par jour',
      keysPerAddress: 'Clés par adresse',
    },
    notes: {
      addresses:
        "Toutes les adresses d'une clé : sur ses propres domaines, y compris celles créées par leur catch-all, et sur les domaines partagés. Une fois la limite atteinte, le catch-all de ses domaines ne crée plus d'adresse et leurs e-mails sont refusés.",
      addressesPerHour: 'Sur la dernière heure, adresses supprimées comprises.',
      pendingDomains:
        "Les domaines connectés par une clé dont l'enregistrement de propriété n'est pas encore trouvé. Chacun coûte au serveur une clé DKIM.",
      recipientsPerDay:
        "Sur les dernières 24 heures, quel que soit l'expéditeur sur le domaine. Un e-mail qui dépasserait la limite n'est pas envoyé.",
      keysPerAddress:
        'Les clés auxquelles une adresse est distribuée. Une clé est toujours permise, et une adresse garde ses clés quand le quota baisse.',
    },
    serverTitle: 'Quotas du serveur',
    serverNote: "Chaque clé y est soumise, sauf les admins, qui n'en ont aucun. Un champ vide signifie sans limite.",
    noLimit: 'Sans limite',
    unlimited: 'sans limite',
    keysTitle: 'Clés avec leurs propres quotas',
    keysNote: 'Ces clés ont ces quotas à la place de ceux du serveur, et ceux du serveur pour le reste.',
    keysEmpty: "Aucune clé n'a ses propres quotas.",
    giveKey: 'Donner ses propres quotas à une clé',
    key: 'Clé',
    fieldsNote: 'Un champ vide garde le quota du serveur.',
    server: (value: string) => `Serveur : ${value}`,
    item: (name: string, value: string) => `${name} : ${value}`,
    change: 'Modifier',
    changeLabel: (npub: string) => `Modifier les quotas de ${npub}`,
    removeLabel: (npub: string) => `Rendre à ${npub} les quotas du serveur`,
  },

  settings: {
    size: {
      title: 'Taille maximale des messages',
      note: "Les e-mails au-delà de cette taille sont refusés à l'arrivée, et ne sont pas envoyés quand un client les transmet.",
      label: 'Taille maximale des messages, en Mo',
      unit: 'Mo',
    },
    blossom: {
      title: 'Serveurs Blossom',
      note: 'Donnés aux nouveaux domaines pour les e-mails trop gros pour un gift wrap, et utilisés par la clé du serveur lui-même. Les domaines connectés gardent les leurs.',
    },
    domainRelays: {
      title: 'Relais des domaines',
      note: "Chaque clé de domaine les annonce, et les e-mails à envoyer y parviennent au serveur. Enregistrer republie les listes de chaque clé de domaine. Le serveur continue d'écouter un relais retiré pendant sept jours, pour les clients qui n'ont pas vu le changement.",
    },
    indexerRelays: {
      title: "Relais d'indexation",
      note: 'Là où le serveur cherche les relais et les serveurs Blossom des autres clés. Les clés de domaine y publient aussi leurs listes.',
    },
    onePerLine: (title: string) => `${title}, un par ligne`,
  },

  errors: {
    codes: {
      invalid_domain: 'Saisissez un nom de domaine, comme example.com.',
      domain_not_found: "Ce domaine n'est plus connecté à votre clé. Rechargez la page.",
      domain_not_verified: "Vérifiez le domaine avant d'ajouter des adresses.",
      invalid_local_part: 'Utilisez des lettres, chiffres, points, tirets et tirets bas, 64 caractères au plus.',
      reserved_local_part: 'Ce nom est réservé.',
      invalid_pubkey: 'Saisissez un npub ou une clé publique hexadécimale.',
      invalid_pubkeys: 'Saisissez un npub ou une clé publique hexadécimale.',
      address_not_found: "Cette adresse n'existe plus. Rechargez la page.",
      address_taken: 'Cette adresse est prise. Choisissez un autre nom.',
      address_deleted:
        "Cette adresse a été supprimée. Le propriétaire du domaine doit l'autoriser à nouveau avant que quiconque la crée.",
      deleted_address_not_found: "Cette adresse n'est plus supprimée. Rechargez la page.",
      domain_not_shared: 'Ce domaine ne laisse plus tout le monde créer des adresses. Rechargez la page.',
      invalid_shared: "Le serveur n'a pas compris ce changement. Rechargez la page.",
      invalid_catch_all: "Le serveur n'a pas compris ce changement. Rechargez la page.",
      domain_shared: "Tout le monde peut créer des adresses sur ce domaine. Fermez-le d'abord à tous.",
      domain_catch_all: "Le catch-all est activé. Désactivez-le d'abord.",
      invalid_nsec: 'Saisissez une clé secrète commençant par nsec1.',
      owner_key: "C'est la clé utilisée pour vous connecter. Utilisez une clé créée pour ce domaine seulement.",
      key_in_use: 'Un autre domaine utilise déjà cette clé.',
      key_in_bunker: "Cette clé est dans votre bunker : le serveur n'a aucun nsec à afficher.",
      invalid_bunker_url: 'Saisissez un lien bunker:// avec au moins un relais wss://.',
      bunker_refused: 'Votre bunker a refusé. Laissez ce serveur signer et chiffrer avec NIP-44 sans vous demander.',
      bunker_auth_url:
        'Votre bunker demande une approbation dans un navigateur. Collez un lien bunker:// qui inclut son secret.',
      not_admin: "Cette clé n'est pas admin de ce serveur. Ajoutez son npub à ADMIN_PUBKEYS.",
      domain_suspended: "L'admin de ce serveur a suspendu ce domaine.",
      suspension_not_found: "Ce domaine n'est plus suspendu. Rechargez la page.",
      not_allowed: 'Ce serveur est privé : son admin choisit les clés qui connectent des domaines.',
      allowed_key_not_found: "Cette clé n'est plus autorisée. Rechargez la page.",
      abuse_report_not_found: "Ce signalement n'existe plus. Rechargez la page.",
      invalid_max_message_bytes: 'Saisissez une taille entre 1 et 1024 Mo.',
      invalid_quotas: 'Saisissez des nombres entiers, ou laissez un champ vide.',
      key_quotas_not_found: "Cette clé n'a plus ses propres quotas. Rechargez la page.",
      pending_domain_quota:
        "Vous avez autant de domaines en attente de vérification que ce serveur le permet. Vérifiez-en ou retirez-en un d'abord.",
      address_quota:
        "Vous avez autant d'adresses que ce serveur le permet. Supprimez-en une d'abord, ou demandez-en plus à son admin.",
      address_rate_quota:
        "Vous avez créé autant d'adresses en une heure que ce serveur le permet. Réessayez plus tard.",
      keys_per_address_quota:
        "Cette adresse a autant de clés que ce serveur le permet. Retirez-en une d'abord, ou demandez-en plus à son admin.",
      invalid_blossom_servers: "Saisissez au moins une URL https:// d'un serveur public, une par ligne.",
      invalid_domain_relays: "Saisissez au moins une URL wss:// d'un relais public, une par ligne.",
      invalid_indexer_relays: "Saisissez au moins une URL wss:// d'un relais public, une par ligne.",
      no_extension: 'Aucune extension Nostr trouvée dans ce navigateur.',
      invalid_bunker: 'Saisissez un lien bunker://, le nom@domaine de votre bunker, un nsec ou un ncryptsec.',
      bunker_timeout: "Votre bunker n'a pas répondu à temps.",
      nostr_connect_closed: 'Les relais ont fermé la connexion. Affichez à nouveau le QR code.',
      invalid_secret_key: 'Saisissez une clé secrète commençant par nsec1 ou ncryptsec1.',
      wrong_password: "Ce mot de passe n'ouvre pas ce ncryptsec.",
      account_signed_out: 'Ce compte a été déconnecté dans un autre onglet. Reconnectez-vous avec.',
    },
    signatureRefused: (code: string) => `Le serveur a refusé la signature (${code}).`,
    status: (status: number, code: string) => `Le serveur a répondu ${status} (${code}).`,
    unreachable: 'Impossible de joindre le serveur.',
  },
}

export default fr
