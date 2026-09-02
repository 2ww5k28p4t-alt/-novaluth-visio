/* ==========================================================================
   NOVALUTH — configuration du kit juridique
   ==========================================================================
   Ce fichier est le SEUL à modifier. Il contient :
     1. vos informations d'entreprise
     2. votre assurance
     3. votre médiateur de la consommation
     4. les réglages par défaut du devis
     5. la grille tarifaire NovaLuth
     6. les modèles de prestation du générateur de devis

   Les valeurs marquées A_COMPLETER sont les seules qu'il reste à saisir :
   personne d'autre que vous ne peut les connaître.
   Ne supprimez ni les virgules, ni les guillemets, ni les accolades.
   ========================================================================== */

window.CONFIG = {
  /* ----------------------------------------------------------------------
     1. VOTRE ENTREPRISE
     ---------------------------------------------------------------------- */
  entreprise: {
    nom: 'NovaLuth',

    // En entreprise individuelle, la dénomination légale doit être composée de
    // votre nom ou nom d'usage, précédé ou suivi de « EI » (art. R123-237 du
    // Code de commerce). NovaLuth n'est alors qu'un nom commercial.
    // Une fois votre nom civil connu, écrivez par exemple :
    //   nom: 'Prénom NOM EI — NovaLuth'
    // et laissez mentionEI vide.
    mentionEI: '',

    // En société, remplacez par 'SASU' ou 'SARL' et renseignez capital + rcs.
    formeJuridique: 'Entreprise individuelle (micro-entrepreneur)',
    capital: '', // laissez vide en entreprise individuelle

    adresse: 'A_COMPLETER — votre adresse complète, Marseille, France',
    siren: 'A_COMPLETER — 9 chiffres du SIREN',
    siret: 'A_COMPLETER — 14 chiffres du SIRET',
    rcs: '', // pas de RCS en entreprise individuelle non commerçante

    // Par défaut : franchise en base de TVA (micro-entreprise).
    // Si vous êtes assujetti : 'FR00000000000' et tauxTvaDefaut à 20.
    tva: 'TVA non applicable, art. 293 B du CGI',

    telephone: 'A_COMPLETER — +33 6 00 00 00 00',
    email: 'contact@novaluth.com',
    siteWeb: 'https://www.novaluth.com',
    representant: 'A_COMPLETER — Prénom NOM, entrepreneur individuel',
    iban: 'A_COMPLETER — IBAN du compte professionnel',
  },

  /* ----------------------------------------------------------------------
     2. ASSURANCE
     Non obligatoire pour une plateforme de mise en relation, mais fortement
     recommandée (responsabilité civile professionnelle).
     ---------------------------------------------------------------------- */
  assurance: {
    assureur: 'A_COMPLETER — nom de votre assureur RC professionnelle',
    numeroContrat: 'A_COMPLETER',
    zone: 'France métropolitaine et Union européenne',
    decennale: '', // sans objet pour NovaLuth
  },

  /* ----------------------------------------------------------------------
     3. MÉDIATEUR DE LA CONSOMMATION — OBLIGATOIRE (art. L612-1)
     Les musiciens sont des consommateurs : l'obligation s'applique même si
     eux ne paient rien. Adhérez à un médiateur agréé, puis recopiez ses infos.
     Liste des médiateurs agréés :
     https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/vos-principales-obligations-0
     ---------------------------------------------------------------------- */
  mediateur: {
    nom: 'A_COMPLETER — nom du médiateur agréé',
    adresse: 'A_COMPLETER — adresse postale du médiateur',
    site: 'https://www.economie.gouv.fr/mediation-conso',
    // Site d'information de la Commission européenne sur les voies de recours.
    // L'ancienne plateforme européenne RLL/ODR a fermé le 20 juillet 2025 :
    // le lien vers celle-ci n'est plus obligatoire (règlement (UE) 2024/3228).
    infoUE: 'https://consumer-redress.ec.europa.eu/index_fr',
  },

  /* ----------------------------------------------------------------------
     4. RÉCLAMATIONS ET DONNÉES PERSONNELLES
     ---------------------------------------------------------------------- */
  contactReclamation: 'contact@novaluth.com',
  contactRgpd: 'contact@novaluth.com',

  /* ----------------------------------------------------------------------
     5. RÉGLAGES PAR DÉFAUT DU DEVIS
     ---------------------------------------------------------------------- */
  devis: {
    prefixe: 'NVL',
    validiteJours: 30,
    tauxTvaDefaut: 0, // 0 en franchise de TVA ; 20 si vous êtes assujetti
    acomptePourcentDefaut: 0, // pas d'acompte : le prix est prélevé après accord
    delaiPaiementJours: 15,
  },

  /* ----------------------------------------------------------------------
     6. GRILLE TARIFAIRE NOVALUTH
     Modifiez les montants ici : les modèles de prestation ci-dessous les
     reprennent automatiquement.
     ---------------------------------------------------------------------- */
  tarifs: {
    // Accès aux coordonnées d'un musicien, selon le budget annoncé du projet.
    // Prélevé uniquement si le musicien accepte l'échange.
    accesPetitProjet: 9.99, // budget annoncé inférieur à 1 500 €
    accesProjetCourant: 15.99, // budget annoncé de 1 500 € à 4 000 €
    accesGrandeCommande: 24.99, // budget annoncé supérieur à 4 000 €

    // Carnets d'accès prépayés : somme versée d'avance, majorée.
    // Utilisables uniquement sur NovaLuth, jamais reversés en argent.
    carnetPetitPrix: 69,
    carnetPetitSolde: 79.95,
    carnetGrandPrix: 119,
    carnetGrandSolde: 159.9,
    carnetValiditeMois: 24,

    // Délai laissé au musicien pour répondre avant annulation automatique.
    delaiReponseMusicienJours: 5,

    // Offres optionnelles, non lancées à ce jour : montants d'exemple.
    ficheVerifiee: 90,
    ficheMiseAJour: 25,
    abonnementAtelierMensuel: 19,
    contenuMarque: 250,
    encartMarque: 150,
  },

  /* ----------------------------------------------------------------------
     7. MODÈLES DE PRESTATION
     Le générateur de devis les propose dans une liste déroulante. Choisir un
     modèle remplit la qualité du client, le mode de conclusion, l'objet, les
     livrables, le délai, le lieu et les lignes du décompte.
     qualite : 'conso' (particulier) ou 'pro' (professionnel)
     mode    : 'distance', 'etablissement' ou 'hors' (hors établissement)
     ---------------------------------------------------------------------- */
  prestations: [
    /* ---- Accès aux coordonnées, par tranche de budget ------------------ */
    {
      cle: 'acces-petit',
      titre: 'Accès à un projet — petit projet (budget < 1 500 €) — 9,99 €',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Accès aux coordonnées et au brief structuré d’un musicien dont le projet est ' +
        'annoncé à moins de 1 500 € de budget, sous réserve de son acceptation expresse.',
      livrables:
        'Coordonnées du musicien, brief structuré (instrument, besoin, budget annoncé, ' +
        'délai souhaité), historique de l’échange dans l’espace atelier.',
      duree:
        'Autorisation posée à la demande, sans débit ; encaissement uniquement si le musicien ' +
        'accepte. Sans réponse sous 5 jours, l’autorisation est annulée et rien n’est dû.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        {
          designation: 'Accès aux coordonnées d’un musicien — tranche petit projet (< 1 500 €)',
          qte: 1,
          pu: 9.99,
        },
      ],
    },
    {
      cle: 'acces-courant',
      titre: 'Accès à un projet — projet courant (1 500 € à 4 000 €) — 15,99 €',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Accès aux coordonnées et au brief structuré d’un musicien dont le projet est ' +
        'annoncé entre 1 500 € et 4 000 € de budget, sous réserve de son acceptation expresse.',
      livrables:
        'Coordonnées du musicien, brief structuré (instrument, besoin, budget annoncé, ' +
        'délai souhaité), historique de l’échange dans l’espace atelier.',
      duree:
        'Autorisation posée à la demande, sans débit ; encaissement uniquement si le musicien ' +
        'accepte. Sans réponse sous 5 jours, l’autorisation est annulée et rien n’est dû.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        {
          designation: 'Accès aux coordonnées d’un musicien — tranche projet courant (1 500 € à 4 000 €)',
          qte: 1,
          pu: 15.99,
        },
      ],
    },
    {
      cle: 'acces-grande',
      titre: 'Accès à un projet — grande commande (> 4 000 €) — 24,99 €',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Accès aux coordonnées et au brief structuré d’un musicien dont le projet est ' +
        'annoncé à plus de 4 000 € de budget, sous réserve de son acceptation expresse.',
      livrables:
        'Coordonnées du musicien, brief structuré (instrument, besoin, budget annoncé, ' +
        'délai souhaité), historique de l’échange dans l’espace atelier.',
      duree:
        'Autorisation posée à la demande, sans débit ; encaissement uniquement si le musicien ' +
        'accepte. Sans réponse sous 5 jours, l’autorisation est annulée et rien n’est dû.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        {
          designation: 'Accès aux coordonnées d’un musicien — tranche grande commande (> 4 000 €)',
          qte: 1,
          pu: 24.99,
        },
      ],
    },

    /* ---- Carnets d'accès prépayés -------------------------------------- */
    {
      cle: 'carnet-69',
      titre: 'Carnet d’accès prépayé — 69 € pour 79,95 € de solde',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Versement d’une avance de 69 € créditée 79,95 € sur le compte atelier, utilisable ' +
        'pour régler les accès aux projets selon la grille en vigueur.',
      livrables:
        'Solde de 79,95 € porté au compte atelier, historique des réservations et des ' +
        'restitutions, relevé consultable à tout moment. Chaque demande d’accès réserve le ' +
        'prix de sa tranche et le rend au solde si elle n’aboutit pas.',
      duree:
        'Solde valable 24 mois à compter du versement, utilisable uniquement sur NovaLuth, ' +
        'non reversé en argent et non cessible.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Carnet d’accès prépayé — avance de 69 €, solde crédité de 79,95 €', qte: 1, pu: 69 },
      ],
    },
    {
      cle: 'carnet-119',
      titre: 'Carnet d’accès prépayé — 119 € pour 159,90 € de solde',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Versement d’une avance de 119 € créditée 159,90 € sur le compte atelier, utilisable ' +
        'pour régler les accès aux projets selon la grille en vigueur.',
      livrables:
        'Solde de 159,90 € porté au compte atelier, historique des réservations et des ' +
        'restitutions, relevé consultable à tout moment. Chaque demande d’accès réserve le ' +
        'prix de sa tranche et le rend au solde si elle n’aboutit pas.',
      duree:
        'Solde valable 24 mois à compter du versement, utilisable uniquement sur NovaLuth, ' +
        'non reversé en argent et non cessible.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Carnet d’accès prépayé — avance de 119 €, solde crédité de 159,90 €', qte: 1, pu: 119 },
      ],
    },

    /* ---- Service au musicien : gratuit --------------------------------- */
    {
      cle: 'musicien-gratuit',
      titre: 'Musicien — récapitulatif de service sans frais (0 €)',
      qualite: 'conso',
      mode: 'distance',
      objet:
        'Dépôt et diffusion du projet du musicien auprès des ateliers compatibles, sans aucun ' +
        'frais à sa charge. Le musicien reste libre d’accepter ou de refuser chaque demande ' +
        'de contact et peut clôturer son projet à tout moment.',
      livrables:
        'Confirmation du projet par courriel, page de suivi personnelle, réception des ' +
        'demandes de contact d’ateliers, effacement des coordonnées à la clôture du projet.',
      duree:
        'Projet actif jusqu’à sa clôture par le musicien ; chaque demande d’atelier reste ' +
        'ouverte 5 jours avant annulation automatique.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Dépôt et diffusion du projet du musicien — service sans frais', qte: 1, pu: 0 },
      ],
    },

    /* ---- Offres optionnelles (montants d'exemple à ajuster) ------------ */
    {
      cle: 'fiche-verifiee',
      titre: 'Option — création et vérification d’une fiche annuaire (90 €)',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Création, structuration et vérification d’une fiche annuaire d’atelier : collecte des ' +
        'informations à partir des sources publiques, rédaction descriptive en vocabulaire ' +
        'fermé, contrôle de provenance, relecture par l’artisan puis publication.',
      livrables:
        'Fiche annuaire publiée, façons de travailler cochées et sourcées, mention de ' +
        'provenance (« d’après ses pages publiques » ou « relu par l’artisan »), droit de ' +
        'rectification depuis l’espace atelier à tout moment.',
      duree: '5 jours ouvrés à compter de la réception des informations',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Création et vérification d’une fiche annuaire d’atelier', qte: 1, pu: 90 },
        { designation: 'Mise à jour de la fiche (par intervention, au-delà de la première année)', qte: 0, pu: 25 },
      ],
    },
    {
      cle: 'abonnement-atelier',
      titre: 'Option — abonnement atelier mensuel (19 €)',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Abonnement mensuel donnant droit à une fiche annuaire enrichie, à la réception des ' +
        'briefs de musiciens compatibles et à un tableau de bord de suivi des échanges.',
      livrables:
        'Fiche annuaire enrichie et modifiable, réception des briefs compatibles, tableau de ' +
        'bord des échanges, assistance par courriel sous 2 jours ouvrés.',
      duree:
        'Un mois, renouvelable par tacite reconduction, résiliable à tout moment depuis ' +
        'l’espace atelier avec effet à la fin de la période en cours.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Abonnement mensuel atelier — fiche enrichie et briefs compatibles', qte: 1, pu: 19 },
      ],
    },
    {
      cle: 'visibilite-marque',
      titre: 'Option — mise en avant éditoriale d’une marque (400 €)',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Réalisation et diffusion d’un contenu éditorial présentant une marque d’instruments ' +
        'émergente sur la plateforme NovaLuth, sans classement de mérite ni comparaison avec ' +
        'd’autres marques ou ateliers.',
      livrables:
        'Article éditorial signalé comme communication commerciale, encart de mise en avant ' +
        'pendant la durée convenue, rapport de diffusion en fin de période.',
      duree: '30 jours de diffusion, contenu livré sous 10 jours ouvrés',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Contenu éditorial de présentation d’une marque (rédaction et intégration)', qte: 1, pu: 250 },
        { designation: 'Encart de mise en avant — 30 jours de diffusion', qte: 1, pu: 150 },
      ],
    },
    {
      cle: 'pack-lancement',
      titre: 'Option — pack lancement atelier (fiche vérifiée + carnet 69 €)',
      qualite: 'pro',
      mode: 'distance',
      objet:
        'Pack de démarrage réunissant la création et la vérification de la fiche annuaire de ' +
        'l’atelier et un carnet d’accès prépayé de 69 € crédité 79,95 €.',
      livrables:
        'Fiche annuaire publiée et relue par l’artisan, solde de 79,95 € porté au compte ' +
        'atelier, prise en main de l’espace atelier par courriel.',
      duree:
        'Fiche livrée sous 5 jours ouvrés ; solde du carnet valable 24 mois, utilisable ' +
        'uniquement sur NovaLuth et non reversé en argent.',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Création et vérification d’une fiche annuaire d’atelier', qte: 1, pu: 90 },
        { designation: 'Carnet d’accès prépayé — avance de 69 €, solde crédité de 79,95 €', qte: 1, pu: 69 },
      ],
      remise: 10, // remise de lancement en pourcentage
    },
  ],
};
