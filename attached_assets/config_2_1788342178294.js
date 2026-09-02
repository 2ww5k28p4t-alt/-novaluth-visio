/* ==========================================================================
   NOVALUTH — configuration du kit juridique
   Tout est déjà pré-rempli. Les seules valeurs qu'il reste à saisir sont
   marquées « A_COMPLETER » : personne d'autre que vous ne peut les connaître
   (numéro SIREN, médiateur agréé, assurance, IBAN).
   Ne supprimez ni les virgules, ni les guillemets, ni les accolades.
   ========================================================================== */

window.CONFIG = {
  // ---- Votre entreprise -------------------------------------------------
  entreprise: {
    nom: 'NovaLuth',

    // En entreprise individuelle, la dénomination doit être composée de votre nom
    // ou nom d'usage, précédé ou suivi de « EI » (art. R123-237 C. com.).
    // NovaLuth n'est alors qu'un nom commercial. Une fois votre nom civil ajouté
    // ci-dessus, écrivez par exemple :
    //   nom: 'Prénom NOM EI — NovaLuth'
    // et laissez mentionEI vide. Tant que le nom civil n'est pas renseigné,
    // cette valeur reste vide pour ne pas afficher une dénomination erronée.
    mentionEI: '',

    // Si vous créez une société, remplacez par 'SASU' ou 'SARL'
    // et renseignez le capital juste en dessous.
    formeJuridique: 'Entreprise individuelle (micro-entrepreneur)',
    capital: '', // laissez vide en entreprise individuelle

    adresse: 'A_COMPLETER — votre adresse complète, Marseille, France',
    siren: 'A_COMPLETER — 9 chiffres du SIREN',
    siret: 'A_COMPLETER — 14 chiffres du SIRET',

    // En entreprise individuelle non commerçante il n'y a pas de RCS :
    // laissez vide. En société, mettez 'RCS Marseille 000 000 000'.
    rcs: '',

    // Par défaut : franchise en base de TVA (micro-entreprise).
    // Si vous êtes assujetti, remplacez par votre numéro : 'FR00000000000'
    // et passez tauxTvaDefaut à 20 plus bas.
    tva: 'TVA non applicable, art. 293 B du CGI',

    telephone: 'A_COMPLETER — +33 6 00 00 00 00',
    email: 'contact@novaluth.com',
    siteWeb: 'https://www.novaluth.com',
    representant: 'A_COMPLETER — Prénom NOM, entrepreneur individuel',
    iban: 'A_COMPLETER — IBAN du compte professionnel',
  },

  // ---- Assurance --------------------------------------------------------
  // Non obligatoire pour une plateforme de mise en relation, mais fortement
  // recommandée (responsabilité civile professionnelle).
  assurance: {
    assureur: 'A_COMPLETER — nom de votre assureur RC professionnelle',
    numeroContrat: 'A_COMPLETER',
    zone: 'France métropolitaine et Union européenne',
    decennale: '', // sans objet pour NovaLuth : laissez vide
  },

  // ---- Médiateur de la consommation (OBLIGATOIRE — art. L612-1) ---------
  // Seule démarche externe indispensable : adhérer à un médiateur agréé,
  // puis recopier ici son nom, son adresse et son site.
  // Liste des médiateurs agréés :
  // https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/vos-principales-obligations-0
  mediateur: {
    nom: 'A_COMPLETER — nom du médiateur agréé',
    adresse: 'A_COMPLETER — adresse postale du médiateur',
    site: 'https://www.economie.gouv.fr/mediation-conso',
    // Site d'information de la Commission européenne sur les voies de recours.
    // L'ancienne plateforme européenne RLL/ODR a été fermée le 20 juillet 2025 :
    // le lien vers celle-ci n'est plus obligatoire (règlement (UE) 2024/3228).
    infoUE: 'https://consumer-redress.ec.europa.eu/index_fr',
  },

  // ---- Réclamations et données personnelles -----------------------------
  contactReclamation: 'contact@novaluth.com',
  contactRgpd: 'contact@novaluth.com',

  // ---- Paramètres par défaut du devis -----------------------------------
  devis: {
    prefixe: 'NVL',
    validiteJours: 30,
    tauxTvaDefaut: 0, // 0 en franchise de TVA ; passez à 20 si vous êtes assujetti
    acomptePourcentDefaut: 0, // pas d'acompte sur un service activé immédiatement
    delaiPaiementJours: 15,
  },

  // ---- Modèles de prestation NovaLuth -----------------------------------
  // Le générateur de devis propose ces modèles dans une liste déroulante et
  // remplit l'objet, les livrables et les lignes du décompte automatiquement.
  // Les montants sont des exemples : ajustez-les à votre grille tarifaire.
  prestations: [
    {
      cle: 'mise-en-relation',
      titre: 'Mise en relation à l’unité (accès aux coordonnées)',
      objet:
        'Mise en relation entre l’atelier et un musicien ayant accepté l’échange, ' +
        'incluant la transmission des coordonnées et du brief structuré du musicien.',
      livrables:
        'Coordonnées du musicien, brief structuré (instrument, besoin, budget, délai), ' +
        'historique de l’échange accessible depuis le compte atelier.',
      duree: 'Accès immédiat après acceptation du musicien',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Accès aux coordonnées d’un musicien après accord (mise en relation)', qte: 1, pu: 15 },
      ],
    },
    {
      cle: 'abonnement-atelier',
      titre: 'Abonnement atelier — fiche annuaire enrichie (mensuel)',
      objet:
        'Abonnement mensuel donnant droit à une fiche annuaire enrichie, à la réception ' +
        'des briefs de musiciens compatibles et à un tableau de bord de suivi des échanges.',
      livrables:
        'Fiche annuaire enrichie et modifiable, réception des briefs compatibles, ' +
        'tableau de bord des échanges, assistance par courriel.',
      duree: 'Un mois, renouvelable par tacite reconduction, résiliable à tout moment',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Abonnement mensuel atelier — fiche annuaire enrichie et briefs compatibles', qte: 1, pu: 19 },
      ],
    },
    {
      cle: 'fiche-verifiee',
      titre: 'Création et vérification d’une fiche annuaire',
      objet:
        'Création, structuration et vérification d’une fiche annuaire d’atelier : collecte ' +
        'des informations, rédaction descriptive, contrôle de provenance des sources, ' +
        'publication après validation de l’atelier.',
      livrables:
        'Fiche annuaire publiée, vocabulaire descriptif fermé (spécialités, matériaux, ' +
        'délais indicatifs), justificatifs de provenance des informations, droit de ' +
        'rectification à tout moment.',
      duree: '5 jours ouvrés à compter de la réception des informations',
      lieu: 'À distance, via la plateforme novaluth.com',
      lignes: [
        { designation: 'Création et vérification d’une fiche annuaire d’atelier', qte: 1, pu: 90 },
        { designation: 'Mise à jour de la fiche (par intervention, au-delà de la première année)', qte: 0, pu: 25 },
      ],
    },
    {
      cle: 'visibilite-marque',
      titre: 'Mise en avant éditoriale d’une marque émergente',
      objet:
        'Réalisation et diffusion d’un contenu éditorial présentant une marque ' +
        'd’instruments émergente sur la plateforme NovaLuth, sans classement de mérite ' +
        'ni comparaison avec d’autres marques ou ateliers.',
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
  ],
};
