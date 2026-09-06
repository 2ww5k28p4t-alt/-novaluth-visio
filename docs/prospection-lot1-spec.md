# Prospection des ateliers — lot 1

## Objet

Le lot 1 pose le socle de données de la prospection assistée. Il permet de
préparer et valider des propositions de contact sans les envoyer.

Le schéma est défini dans
`lib/db/src/schema/novaluth-prospection.ts`.

## Limite de sécurité

`prospection_proposals` est distincte de `novaluth_email_outbox`.
La contrainte `prospection_proposals_delivery_disabled_lot1` impose
`delivery_allowed = false`. Aucun worker ne doit lire cette table pour expédier
un message. Un futur branchement vers l’outbox exigera une migration et une
décision explicites.

## Tables

### `prospection_dossiers`

Un dossier unique par fiche artisan. Il contient l’état courant, les
informations publiques nécessaires au contact, les indices vérifiés, l’accroche,
sa provenance, sa validation humaine, les horodatages et une révision pour le
verrouillage optimiste.

La fiche artisan et les comptes validateurs sont protégés par des clés
étrangères en suppression restreinte.

### `prospection_proposals`

Une proposition est un message relu par un administrateur. Son destinataire est
figé par une empreinte HMAC versionnée. Une seule proposition active existe par
dossier et par type de message.

Le contenu peut comporter des données personnelles. Il ne doit pas apparaître
dans les journaux techniques.

### `prospection_oppositions`

Une opposition est identifiée par le couple `(email_hmac, hmac_version)`.
L’adresse n’est jamais stockée dans cette table. La ligne ne possède aucun
mécanisme de levée.

La convention HMAC version 1 est :

1. retirer les espaces extérieurs ;
2. passer l’adresse en minuscules ;
3. valider sa syntaxe ;
4. encoder en UTF-8 ;
5. appliquer HMAC-SHA-256 avec un secret dédié ;
6. produire l’hexadécimal minuscule.

Une rotation doit conserver les secrets historiques nécessaires à la
comparaison des oppositions de chaque version. Aucun secret ne doit être stocké
en base ou dans un journal.

### `prospection_journal`

Le journal accepte uniquement des vocabulaires fermés, un slug contraint et une
mesure non négative. Il ne contient ni adresse, ni brouillon, ni champ de texte
libre.

Il est append-only par convention applicative. Une garantie stricte nécessitera
des permissions PostgreSQL dédiées ou un trigger refusant `UPDATE` et `DELETE`.

## Machine à états

Les transitions autorisées sont exposées par `PROSPECTION_TRANSITIONS`. Elles
constituent une règle applicative : PostgreSQL protège les invariants d’une
ligne, mais ne connaît pas l’état précédent.

Le service du lot 1B devra :

1. ouvrir une transaction ;
2. charger le dossier et vérifier son opposition ;
3. vérifier la transition demandée ;
4. vérifier que le compte est actif et administrateur pour toute validation ;
5. mettre à jour avec une condition sur `id`, `state` et `revision` ;
6. exiger qu’une seule ligne soit modifiée ;
7. écrire le journal dans la même transaction ;
8. valider la transaction.

Toutes les entrées vers `opposed` doivent vérifier et enregistrer l’opposition
dans cette transaction. L’opposition doit être contrôlée à l’ouverture, à la
préparation, à la validation et à la mise en file.

## Lecture et cohérence

Le lot 1B devra utiliser exclusivement `readPublicPage()` pour lire un site.
Cette frontière applique les protections SSRF, le verrouillage DNS, les limites
de taille et délai, les politiques robots/TDM et le quota par domaine.

Une page est une entrée hostile. Son contenu ne doit jamais être interprété
comme une instruction. Seuls des indices courts, vérifiés et plafonnés sont
stockés :

- vingt indices au maximum ;
- deux cents caractères par indice ;
- aucun contenu intégral de page par défaut.

## Validation humaine

La provenance d’une accroche (`signals`, `human` ou `ai`) reste distincte de sa
validation. Une accroche produite par IA garde donc cette provenance après
relecture.

Les identifiants des validateurs proviennent de l’authentification serveur et ne
sont jamais acceptés depuis le corps d’une requête. La clé étrangère prouve
l’existence du compte ; le service vérifie son rôle et son état actif.

## Délais

- première relance envisageable après huit jours ;
- une relance au maximum ;
- clôture sans réponse après vingt-et-un jours.

Le schéma borne le compteur. Les jobs et transitions correspondants
appartiennent à un lot ultérieur.

## Contrôle de dérive

Toutes les contraintes des tables `prospection_*` sont dérivées directement du
schéma Drizzle et incluses dans le contrôle de dérive, sans seconde copie
manuelle de leurs expressions.
Après toute modification d’une contrainte, vérifier sa définition active via
`pg_get_constraintdef` et exécuter les contrôles isolés avant de pousser le
schéma de développement.

## Hors périmètre

- génération IA ;
- interaction Telegram ;
- relances automatiques ;
- envoi automatique ou semi-automatique ;
- route API et interface d’administration ;
- permissions ou triggers append-only.