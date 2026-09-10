# Atlas des luthiers d'Europe — intégration dans Replit

## Où déposer les fichiers

Tout va dans un seul dossier public du monorepo NovaLuth :

```
artifacts/novaluth/public/atlas/
├── index.html
├── styles.css
├── app.js
├── favicon.svg
├── LICENCES.md              (récapitulatif des licences — à conserver)
├── data/
│   └── luthiers.json        (contient juste [] — secours hors ligne, laissez-le)
└── vendor/                  (bibliothèques servies en local, plus aucun CDN)
    ├── leaflet.js / leaflet.css / images/
    ├── leaflet.markercluster.js / MarkerCluster.css / MarkerCluster.Default.css
    ├── maplibre-gl.js / maplibre-gl.css
    ├── leaflet-maplibre-gl.js
    └── licences/            (textes BSD / MIT / ISC — à conserver)
```

Remplacez l'ancien dossier `atlas/` en entier : le dossier `vendor/` est nouveau et
`index.html` ne pointe plus vers unpkg. La carte est ensuite accessible sur `/atlas/`
de votre application, sans aucune route supplémentaire à écrire.

## Le seul réglage à connaître

Tout en bas de `index.html` :

```js
window.NOVALUTH_ATLAS = Object.assign({
  apiBase: '/',                          // front et API sur la même origine (Replit)
  cheminFiches: '/api/atlas/luthiers',
  cheminSession: '/api/atlas/session',
  intervalleSync: 120000,                // resynchronisation toutes les 2 minutes
  cheminConnexion: '/admin'
}, window.NOVALUTH_ATLAS || {});
```

- `apiBase: '/'` — à garder tel quel si la carte est servie par NovaLuth lui-même.
- `apiBase: 'https://novaluth.com'` — si vous hébergez la carte ailleurs.
- `apiBase: ''` — mode démonstration : la carte lit `data/luthiers.json` et ouvre la
  saisie à tous. À n'utiliser que pour tester l'apparence.

## Le fond de carte

OpenFreeMap, en tuiles vectorielles, rendu par MapLibre à l'intérieur de Leaflet.
Usage commercial autorisé, aucune inscription, aucune clé, aucun quota. Les deux
styles utilisés sont déclarés en haut de `app.js` :

```js
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark'
};
```

L'attribution « OpenFreeMap © OpenMapTiles Data from OpenStreetMap » est obligatoire.
Elle est déjà affichée en bas à droite de la carte et dans le pied de page, générée
depuis la constante `ATTRIBUTION` juste en dessous. Ne la retirez pas.

Les libellés de la carte sont forcés en français quand OpenStreetMap le fournit
(`name:fr`), avec repli sur le nom latin puis le nom local.

Détail à connaître : le rendu vectoriel exige WebGL. Sur un appareil qui ne le prend
pas en charge, la carte reste utilisable — marqueurs, filtres, liste, bulles — avec une
trame discrète à la place du fond dessiné.

Le détail complet des licences, y compris le point à surveiller sur le géocodage, est
dans `LICENCES.md`.

## Côté serveur (déjà poussé sur main)

- `artifacts/api-server/src/routes/atlas.ts` — routes `/api/atlas/session`,
  `/api/atlas/luthiers` (lecture publique), POST/PATCH/DELETE réservés aux
  administrateurs, et `/api/atlas/diagnostic`.
- `lib/db/src/schema/novaluth-atlas.ts` — table `novaluth_atlas_points`.

Si la table n'existe pas encore dans votre base Replit :

```
pnpm --filter @workspace/db run push
```

## Cache du navigateur

`index.html` appelle `styles.css?v=14` et `app.js?v=14`. À chaque modification,
incrémentez ces numéros, sinon les téléphones continuent de servir l'ancienne version.

## Vérification en une minute

1. Ouvrez `/atlas/` **déconnecté** : fond de carte gris affiché, fiches publiées
   visibles, compteur « N ateliers · N pays », attribution OpenFreeMap en bas à
   droite, et **aucun** bouton « Ajouter une fiche ».
2. Basculez le thème sombre en haut à droite : le fond doit passer en gris très foncé.
3. Reconnectez-vous avec le compte administrateur et rechargez : la mention
   « Administrateur NovaLuth » et le bouton de saisie apparaissent.
4. Si la carte reste vide, ouvrez `/api/atlas/diagnostic` connecté en admin : la
   réponse indique le nombre de fiches publiées, de points en base, les pays non
   reconnus et l'état du géocodeur.
