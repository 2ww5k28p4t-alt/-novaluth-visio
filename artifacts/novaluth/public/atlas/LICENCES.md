# Licences de l'atlas — usage commercial sans contrepartie financière

Tous les éléments ci-dessous sont utilisables gratuitement dans un service commercial,
sans abonnement, sans clé payante et sans redevance. Rien n'est à négocier avec un
fournisseur.

| Élément | Licence / conditions | Obligation |
|---|---|---|
| Fond de carte OpenFreeMap (instance publique) | Usage commercial explicitement autorisé, aucune inscription, aucune clé, aucune limite de vues ni de requêtes | Afficher l'attribution sur la carte |
| Données OpenStreetMap (via OpenMapTiles) | ODbL | Créditer OpenStreetMap |
| Leaflet 1.9.4 | BSD 2-Clause | Conserver la mention de copyright (`vendor/licences/`) |
| Leaflet.markercluster 1.5.3 | MIT | Conserver la mention de copyright |
| MapLibre GL JS 5.6.0 | BSD 2-Clause | Conserver la mention de copyright |
| maplibre-gl-leaflet 0.1.0 | ISC | Conserver la mention de copyright |
| Polices Satoshi et Bespoke Serif (Fontshare) | ITF Free Font License — usage personnel et commercial gratuit, auto-hébergement autorisé | Aucune attribution requise |
| Géocodage Photon | Logiciel Apache 2.0 ; serveur public de démonstration en « best effort » | Voir la note ci-dessous |

Les textes de licence des quatre bibliothèques sont reproduits dans
`vendor/licences/`. Il suffit qu'ils restent dans le dépôt : rien à afficher dans
l'interface.

## Attribution obligatoire — ne pas la retirer

Elle est déjà en place à deux endroits, en bas à droite de la carte et dans le pied de
page, et elle est générée depuis une seule constante en haut de `app.js` :

```js
const ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
```

OpenFreeMap précise que la mention « OpenFreeMap » elle-même est facultative ; seules
les parties OpenMapTiles et OpenStreetMap sont exigées. Nous l'affichons quand même.

## Le géocodage, seul point à surveiller

Le logiciel Photon est libre (Apache 2.0), mais `photon.komoot.io` est un serveur de
démonstration : usage intensif « limité ou totalement banni », aucune garantie de
disponibilité. Le secours Nominatim d'OpenStreetMap est plus strict encore : une
requête par seconde maximum et revente des résultats interdite.

Votre usage reste très en dessous de ces seuils — une seule requête par fiche, mise en
cache définitivement en base, huit appels maximum par synchronisation, espacés de
1,2 s. Vous n'êtes donc en infraction avec rien. Mais pour un service payant, la
solution propre est d'auto-héberger Photon : deux fichiers à télécharger, un serveur à
démarrer, et vous ne dépendez plus de personne. Il suffit alors de renseigner la
variable d'environnement déjà prévue :

```
ATLAS_GEOCODAGE_URL=https://votre-photon.exemple.fr/api/
```

Pour couper aussi le fond de carte de toute dépendance externe, OpenFreeMap peut être
auto-hébergé de la même façon : remplacez les deux URL de `STYLES` en haut de `app.js`
par celles de votre serveur.

## Ce qui a été retiré et pourquoi

Le fond de carte précédent venait d'Esri (`services.arcgisonline.com`, World Light et
Dark Gray Canvas). Il n'était pas libre : les conditions d'utilisation imposent un
abonnement ArcGIS Online, interdisent l'auto-hébergement du contenu et réservent
l'usage commercial du Living Atlas à une licence négociée. Il a été remplacé par
OpenFreeMap.

Les bibliothèques étaient auparavant chargées depuis le CDN unpkg. Elles sont
maintenant servies depuis `vendor/`, donc la carte ne dépend plus d'un service tiers
pour fonctionner.
