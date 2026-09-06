# NovaLuth — Lot 1B

## Service transactionnel de prospection et contrôle de cohérence

### Statut du document

Ce brief consolide :

- le schéma de prospection livré au lot 1A ;
- les implémentations déjà fusionnées dans les routes d’administration ;
- les propositions jointes `prospection-service` et
  `prospection-coherence` ;
- les décisions de périmètre prises pour les verrous, la relecture et
  l’absence d’envoi.

Les fichiers joints sont des références de conception. Ils ne doivent pas être
copiés directement dans le dépôt : certains noms, secrets, contrôles
d’identité et ordres de verrouillage ne correspondent pas au code actif.

---

## 1. Objectif

Créer l’unique couche métier autorisée à modifier les tables
`prospection_*`, puis faire passer les routes d’administration existantes par
cette couche.

Le lot doit garantir qu’une action de prospection est :

1. autorisée par un compte NovaLuth administrateur actif ;
2. sérialisée pour l’atelier ou le dossier concerné ;
3. validée contre l’état et la révision courants ;
4. bloquée en présence d’une opposition ;
5. enregistrée avec son événement de journal dans la même transaction ;
6. incapable de provoquer un envoi de courriel.

Le lot ajoute aussi la préparation d’un dossier à partir d’une page publique,
exclusivement par la frontière sécurisée `readPublicPage()`.

---

## 2. État de départ

### Base de données

Le paquet de données est :

```text
@workspace/db
```

Le schéma du lot 1A expose les dossiers, propositions, oppositions et événements
de journal, ainsi que les vocabulaires et transitions de prospection.

Les contraintes PostgreSQL imposent notamment :

- les états et motifs connus ;
- la chronologie des transitions ;
- une seule relance ;
- les métadonnées de validation humaine ;
- l’empreinte versionnée du destinataire ;
- `delivery_allowed = false`.

### Administration déjà fusionnée

Les routes de prospection existantes savent déjà :

- lister et consulter des dossiers ;
- modifier certaines données ;
- valider ou retirer une proposition ;
- marquer certaines étapes.

Elles écrivent encore directement dans les tables de prospection. Le lot 1B
doit déplacer ces décisions métier dans le service transactionnel sans créer
une seconde implémentation parallèle.

### Authentification

L’administration de prospection utilise la session NovaLuth. L’identité du
compte administrateur doit être dérivée côté serveur.

Ne jamais accepter un `accountId`, un rôle ou une identité de validateur venant
du corps de la requête.

Le contrôle canonique est :

```text
account.role === "admin" && account.active
```

Le helper historique `requireAdminToken` n’est pas le modèle à reproduire dans
le nouveau service.

### Lecture publique

La seule frontière autorisée est :

```ts
readPublicPage(rawUrl: string)
```

Elle résout :

```ts
Promise<{
  url: string;
  url_finale: string;
  titre: string;
  texte: string;
  octets: number;
  delai_respecte_s: number;
}>
```

Elle lève `PageReadRefused` lorsque la lecture est interdite ou ne peut pas être
effectuée conformément aux politiques du site.

---

## 3. Décisions de périmètre

### Concurrence

La prévention de deux traitements simultanés du même atelier appartient au
service transactionnel. Elle n’est pas une fonctionnalité séparée.

Utiliser un verrou consultatif transactionnel PostgreSQL, pris avant toute
lecture ou écriture métier :

```sql
pg_try_advisory_xact_lock(...)
```

La clé doit être stable et liée à l’atelier lorsque le dossier n’existe pas
encore, puis au dossier pour les opérations ultérieures.

Le verrou est complété, et non remplacé, par une mise à jour conditionnée sur :

```text
id + état attendu + révision attendue
```

### Relecture sans envoi

La sécurité de relecture est déjà fondée sur deux invariants :

- `delivery_allowed = false` ;
- aucun worker d’envoi de prospection.

Le lot 1B peut permettre de relire, modifier, valider et retirer une
proposition. Il ne doit créer ni expéditeur, ni écriture dans l’outbox
transactionnelle d’e-mails.

### Sujets absorbés par le lot

Les protections contre la concurrence et l’envoi accidentel font partie de ce
lot. Elles ne doivent pas donner lieu à des implémentations indépendantes.

Les contrôles d’intégrité du journal, du destinataire et de l’accroche doivent
également être traités dans le service, car ils portent sur les mêmes
transactions.

---

## 4. Architecture cible

Créer un répertoire métier dédié, par exemple :

```text
artifacts/api-server/src/lib/prospection/
  errors.ts
  hmac.ts
  locks.ts
  service.ts
  coherence.ts
```

La séparation peut être ajustée si le volume final ne la justifie pas, mais une
seule API publique doit détenir les écritures de prospection.

### Règle d’accès aux tables

Après migration :

- les routes lisent et valident leurs paramètres HTTP ;
- elles récupèrent l’identité de session ;
- elles appellent le service ;
- elles traduisent les erreurs métier en réponses HTTP ;
- elles ne modifient plus directement les tables `prospection_*`.

Les scripts de migration, tests et contrôles de schéma restent autorisés à
manipuler directement ces tables.

---

## 5. Transaction et verrouillage

### Ordre obligatoire

Chaque mutation doit suivre cet ordre dans une transaction unique :

1. dériver ou recevoir du serveur l’identité du compte ;
2. prendre le verrou consultatif ;
3. charger le dossier et ses données liées ;
4. vérifier le compte administrateur actif ;
5. vérifier l’état, la révision et la transition ;
6. vérifier toutes les versions actives d’opposition ;
7. appliquer les écritures métier ;
8. écrire l’événement de journal ;
9. valider la transaction.

Aucune mise à jour de l’accroche, de la proposition ou du destinataire ne doit
précéder la prise du verrou.

### Conflits

Deux opérateurs agissant sur le même atelier ou dossier doivent obtenir :

- un succès ;
- un refus métier explicite pour l’autre opération.

Il ne doit jamais y avoir deux succès, deux propositions actives concurrentes
ou une écriture silencieusement écrasée.

### Idempotence

Une répétition strictement identique peut retourner l’état courant sans créer
un second événement métier.

Une répétition dont la révision, l’état, le destinataire ou l’accroche a changé
doit être refusée explicitement.

---

## 6. Identité administrateur

Le service reçoit l’identifiant de compte uniquement depuis le contexte de
session construit côté serveur.

Dans la transaction, il charge le compte depuis
`novaluthPlatformAccountsTable` et vérifie avec les colonnes typées réelles :

```ts
account.role === "admin" && account.active
```

Éviter les conversions en `Record<string, unknown>` et les colonnes supposées
comme `isActive`, `disabledAt`, `deletedAt` ou `revokedAt`.

Les routes de prospection et les autres fonctions d’administration doivent, à
terme, partager le même modèle d’identité NovaLuth.

---

## 7. HMAC et oppositions

### Convention unique

Définir une seule fonction canonique de normalisation et d’empreinte des
adresses :

1. suppression des espaces périphériques ;
2. minuscules selon une règle stable et indépendante de la locale ;
3. validation de syntaxe ;
4. encodage UTF-8 ;
5. HMAC-SHA-256 ;
6. hexadécimal minuscule ;
7. version stockée avec l’empreinte.

Ne pas maintenir deux conventions entre les routes existantes et le nouveau
service.

Le choix du secret et le plan de rotation doivent être arrêtés avant de migrer
les écritures existantes. Aucun secret ne doit être journalisé ou stocké en
base.

### Contrôle d’opposition

L’opposition est contrôlée dans chaque transaction susceptible de préparer,
valider, proposer ou marquer un contact.

Le contrôle porte sur toutes les versions HMAC encore actives.

L’enregistrement d’une opposition est idempotent et irréversible depuis
l’application.

Éviter de parcourir tous les dossiers dans une longue transaction. Prévoir une
stratégie indexée ou bornée pour retirer les propositions concernées.

---

## 8. Journal

### Atomicité

Le changement métier et son événement de journal appartiennent à la même
transaction :

- si l’écriture métier échoue, aucun événement ne subsiste ;
- si l’écriture du journal échoue, le changement métier est annulé.

### Contenu

Le journal n’accepte que :

- les vocabulaires fermés du schéma ;
- l’identifiant du dossier ;
- le slug chargé depuis la base ;
- les états avant/après ;
- un motif fermé ;
- une mesure numérique bornée.

Ne pas y écrire :

- adresse e-mail ;
- objet ou corps de message ;
- texte de page ;
- accroche ;
- jeton ;
- secret ;
- erreur brute d’un fournisseur.

### Immutabilité

L’insert-only par convention ne suffit pas. Le lot doit empêcher ou détecter
toute modification et suppression silencieuse du journal, puis couvrir cette
garantie par un test PostgreSQL.

---

## 9. Intégrité des propositions

### Validation humaine

La validation enregistre :

- le compte administrateur issu de la session ;
- la date de validation ;
- l’accroche validée ;
- le destinataire figé par HMAC et sa version ;
- le type de proposition ;
- le sujet et le corps bornés.

Le marqueur de rédaction manuelle ne doit plus être présent au moment de la
validation.

### Destinataire et accroche

Une proposition validée devient invalide si, après sa validation :

- l’adresse de contact change ;
- l’accroche change ;
- la validation humaine de l’accroche disparaît ;
- la version HMAC nécessaire n’est plus disponible.

Dans ce cas :

1. retirer la proposition active ;
2. ramener le dossier à l’état de relecture approprié ;
3. écrire l’événement dans la même transaction ;
4. exiger une nouvelle validation humaine.

La vérification doit se produire lors de toute modification concernée, pas
uniquement dans une tâche de réconciliation ultérieure.

### Unicité active

Une opération d’upsert qui n’a ni inséré ni mis à jour de proposition ne doit
jamais poursuivre la transition du dossier.

Le service vérifie explicitement qu’une et une seule proposition active
correspond au dossier et au type attendu.

---

## 10. Préparation et cohérence

### Ouverture

L’ouverture d’un dossier :

- charge une fiche existante depuis la base ;
- prend un verrou lié au slug avant de rechercher ou créer le dossier ;
- copie uniquement les données nécessaires ;
- produit un dossier unique ;
- journalise l’ouverture dans la même transaction.

Une fiche sans site passe dans l’état terminal prévu par le schéma.

### Lecture

La préparation appelle exclusivement :

```ts
readPublicPage(workshop.websiteUrl)
```

Elle n’utilise ni `fetch`, ni client HTTP, ni navigateur directement.

### Classification des échecs

Ne pas considérer toute instance de `PageReadRefused` comme un refus éditorial
définitif. Cette classe couvre également des situations techniques ou de
sécurité.

Classifier explicitement au minimum :

- refus par `robots.txt` ;
- réservation de fouille ;
- cible réseau interdite ;
- contenu non textuel ;
- réponse trop volumineuse ;
- erreur HTTP ;
- délai dépassé ;
- politique impossible à vérifier.

Les refus de politique sont non retentables tant que la politique ne change
pas. Les indisponibilités techniques peuvent rester retentables sans transition
destructive.

Si cette classification doit devenir stable, préférer un code structuré sur
l’erreur plutôt qu’une comparaison fragile des messages.

### Cohérence factuelle

Le contrôle ne doit produire une accroche que lorsque la page fournit assez
d’indices concordants.

Les signaux possibles incluent :

- nom de l’atelier ;
- localisation ;
- pays ;
- année de création ;
- modèle ou instrument ;
- technique ou marqueur vérifiable.

Le rapprochement du nom doit éviter :

- les faux positifs par simple sous-chaîne ;
- les faux négatifs causés par les accents, traits d’union ou raisons sociales ;
- l’exigence absolue d’une ville lorsque la fiche ou le site ne permet pas une
  vérification raisonnable.

Les indices conservés sont courts, caviardés, bornés en nombre et issus du
contenu réellement lu.

### Adresse de contact

Une adresse extraite d’une page doit être :

- syntaxiquement valide ;
- normalisée par la convention canonique ;
- vérifiée contre les oppositions avant stockage ou proposition ;
- rejetée si elle correspond clairement à une ressource technique ou un
  exemple.

L’extraction par expression régulière seule doit être complétée par des tests
sur les formes HTML courantes et les faux positifs.

---

## 11. API du service

L’API finale peut différer dans ses noms, mais doit couvrir au minimum :

```ts
openDossier(...)
prepareDossier(...)
validateHook(...)
validateProposal(...)
withdrawProposal(...)
recordOpposition(...)
markManualOutcome(...)
```

Chaque commande de mutation reçoit :

- les données métier strictement nécessaires ;
- l’identité administrateur issue de la session ;
- l’état ou la révision attendu lorsque l’action dépend d’une vue antérieure.

Elle renvoie une vue métier typée, jamais un résultat Drizzle brut.

### Erreurs métier minimales

Prévoir des erreurs structurées et traduisibles en HTTP :

- authentification requise ;
- administration requise ;
- dossier introuvable ;
- verrou occupé ;
- révision obsolète ;
- transition interdite ;
- opposition active ;
- validation humaine requise ;
- proposition devenue incohérente ;
- lecture refusée ;
- lecture temporairement indisponible.

Les routes restent responsables du code HTTP et du message public.

---

## 12. Tests obligatoires

### PostgreSQL isolé

Tester sur la vraie base PostgreSQL, pas uniquement avec des mocks.

Scénarios minimaux :

1. deux ouvertures concurrentes du même slug produisent un seul dossier ;
2. deux validations concurrentes produisent un succès et un conflit ;
3. le verrou est libéré après succès, erreur et rollback ;
4. une transition sans événement de journal est impossible ;
5. un échec du journal annule la transition ;
6. une ligne de journal ne peut être modifiée ou supprimée silencieusement ;
7. un compte non administrateur ou inactif ne peut écrire ;
8. un identifiant de validateur fourni par le client est ignoré ou refusé ;
9. une opposition bloque chaque étape pertinente ;
10. une opposition reste active après rotation HMAC ;
11. une adresse ou une accroche modifiée retire la proposition ;
12. un upsert sans ligne modifiée ne fait pas avancer le dossier ;
13. aucune proposition ne peut avoir `delivery_allowed = true` ;
14. aucun e-mail ni texte de message n’apparaît dans le journal.

### Lecture et cohérence

Tester :

- lecture autorisée ;
- refus `robots.txt` ;
- réservation `/.well-known/tdmrep.json` ;
- réservation dans les en-têtes ou métadonnées ;
- erreur temporaire de passerelle ;
- page trop courte ;
- atelier homonyme ;
- accents, traits d’union et raison sociale ;
- ville absente ou contradictoire ;
- extraction d’adresse valide ;
- faux positifs d’adresse ;
- plafonds de taille et de nombre des indices.

### Routes

Vérifier que :

- toutes les mutations utilisent l’identité de session ;
- les anciennes écritures directes ont disparu ;
- les conflits métier produisent des réponses déterministes ;
- les listes et détails restent compatibles avec l’interface fusionnée ;
- aucune route ne branche une proposition sur l’outbox d’e-mails.

---

## 13. Ordre d’implémentation

1. Faire l’inventaire des écritures directes `prospection_*` déjà présentes.
2. Arrêter la convention HMAC unique et sa rotation.
3. Créer les erreurs, verrous et helpers transactionnels.
4. Implémenter les commandes de service avec verrou pris en premier.
5. Garantir l’atomicité et l’immutabilité du journal.
6. Migrer les routes fusionnées vers le service.
7. Ajouter l’intégrité destinataire/accroche.
8. Ajouter l’ouverture et la préparation par `readPublicPage()`.
9. Ajouter l’enregistrement d’opposition borné et idempotent.
10. Exécuter les tests PostgreSQL isolés et les tests de routes.

Chaque étape doit conserver `delivery_allowed = false`.

---

## 14. Hors périmètre

Le lot 1B n’inclut pas :

- l’envoi réel de courriels ;
- un worker de livraison ;
- l’écriture dans l’outbox d’e-mails ;
- les relances automatiques ;
- la clôture planifiée ;
- la rédaction par IA ;
- l’arbitrage Telegram ;
- l’activation de fournisseurs externes ;
- les paiements ;
- une refonte générale de l’administration hors prospection.

Les fonctions de diagnostic peuvent signaler les échéances futures, mais elles
ne doivent pas les exécuter.

---

## 15. Critères de livraison

Le lot est terminé lorsque :

- toutes les mutations applicatives passent par un service unique ;
- le service utilise l’identité NovaLuth issue de la session ;
- les verrous précèdent toutes les lectures et écritures métier ;
- état, révision, proposition, opposition et journal sont cohérents
  transactionnellement ;
- une proposition ne survit pas à une modification de son destinataire ou de
  son accroche ;
- l’historique ne peut être altéré silencieusement ;
- la lecture publique passe uniquement par `readPublicPage()` ;
- les refus de politique et erreurs techniques sont distingués ;
- les tests de concurrence passent sur PostgreSQL isolé ;
- les routes fusionnées restent fonctionnelles ;
- aucun chemin d’envoi n’existe ;
- `delivery_allowed` reste toujours faux.
