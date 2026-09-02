export const legalKitConfig = {
  entreprise: {
    nom: "NovaLuth",
    formeJuridique: "Entreprise individuelle (micro-entrepreneur)",
    adresse: "A_COMPLETER — votre adresse complète, Marseille, France",
    siren: "A_COMPLETER — 9 chiffres du SIREN",
    siret: "A_COMPLETER — 14 chiffres du SIRET",
    tva: "TVA non applicable, art. 293 B du CGI",
    telephone: "A_COMPLETER — +33 6 00 00 00 00",
    email: "contact@novaluth.com",
    representant: "A_COMPLETER — Prénom NOM, entrepreneur individuel",
  },
  assurance: {
    assureur: "A_COMPLETER — nom de votre assureur RC professionnelle",
    numeroContrat: "A_COMPLETER",
    zone: "France métropolitaine et Union européenne",
  },
  mediateur: {
    nom: "A_COMPLETER — nom du médiateur agréé",
    adresse: "A_COMPLETER — adresse postale du médiateur",
    site: "https://www.economie.gouv.fr/mediation-conso",
    infoUE: "https://consumer-redress.ec.europa.eu/index_fr",
  },
  contacts: {
    reclamation: "contact@novaluth.com",
    rgpd: "contact@novaluth.com",
  },
  devis: {
    prefixe: "NVL",
    validiteJours: 30,
    tauxTvaDefaut: 0,
    acomptePourcentDefaut: 0,
    delaiPaiementJours: 15,
  },
  tarifs: {
    accesPetitProjet: 9.99,
    accesProjetCourant: 15.99,
    accesGrandeCommande: 24.99,
    carnetPetitPrix: 69,
    carnetPetitSolde: 79.95,
    carnetGrandPrix: 119,
    carnetGrandSolde: 159.9,
    carnetValiditeMois: 24,
    delaiReponseMusicienJours: 5,
    ficheVerifiee: 90,
    ficheMiseAJour: 25,
    abonnementAtelierMensuel: 19,
    contenuMarque: 250,
    encartMarque: 150,
  },
  prestations: [
    {
      cle: "acces-petit",
      titre: "Accès à un projet — petit projet (< 1 500 €)",
      client: "Atelier",
      prix: 9.99,
      objet:
        "Accès aux coordonnées et au brief structuré d’un musicien dont le projet est annoncé à moins de 1 500 €.",
    },
    {
      cle: "acces-courant",
      titre: "Accès à un projet — projet courant (1 500 € à 4 000 €)",
      client: "Atelier",
      prix: 15.99,
      objet:
        "Accès aux coordonnées et au brief structuré d’un musicien dont le projet est annoncé entre 1 500 € et 4 000 €.",
    },
    {
      cle: "acces-grande",
      titre: "Accès à un projet — grande commande (> 4 000 €)",
      client: "Atelier",
      prix: 24.99,
      objet:
        "Accès aux coordonnées et au brief structuré d’un musicien dont le projet est annoncé à plus de 4 000 €.",
    },
    {
      cle: "carnet-69",
      titre: "Carnet d’accès prépayé — 69 € pour 79,95 € de solde",
      client: "Atelier",
      prix: 69,
      objet:
        "Versement d’une avance de 69 € créditée de 79,95 € sur le compte atelier, utilisable uniquement sur NovaLuth.",
    },
    {
      cle: "carnet-119",
      titre: "Carnet d’accès prépayé — 119 € pour 159,90 € de solde",
      client: "Atelier",
      prix: 119,
      objet:
        "Versement d’une avance de 119 € créditée de 159,90 € sur le compte atelier, utilisable uniquement sur NovaLuth.",
    },
    {
      cle: "fiche-verifiee",
      titre: "Création et vérification d’une fiche annuaire",
      client: "Atelier",
      prix: 90,
      objet:
        "Création, structuration et vérification d’une fiche annuaire avec contrôle des sources et validation de l’atelier.",
    },
    {
      cle: "abonnement-atelier",
      titre: "Abonnement atelier — fiche enrichie (mensuel)",
      client: "Atelier",
      prix: 19,
      objet:
        "Abonnement mensuel donnant accès à une fiche enrichie, aux briefs compatibles et au tableau de bord des échanges.",
    },
    {
      cle: "visibilite-marque",
      titre: "Mise en avant éditoriale d’une marque émergente",
      client: "Marque",
      prix: 400,
      objet:
        "Contenu éditorial signalé comme communication commerciale et encart de mise en avant pendant la durée convenue.",
    },
  ],
} as const;

export type LegalKitPrestation = (typeof legalKitConfig.prestations)[number];