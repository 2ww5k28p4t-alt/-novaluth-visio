# Validation de reprise NovaLuth Meet

La validation reproductible `meet-recovery` exécute :

```sh
pnpm run test:meet-recovery
```

## Préconditions vérifiées

- Les workflows gérés `artifacts/novaluth: web` et
  `artifacts/api-server: API Server` doivent être démarrés et accessibles via
  le proxy local. Le scénario vérifie le frontend Meet et `/api/healthz` avant
  d’ouvrir le navigateur, et échoue explicitement si l’un des deux manque.
- Chromium doit être installé sous le nom `chromium`. Un autre exécutable peut
  être fourni avec `CHROMIUM_BIN`.
- Le scénario utilise Chromium headless avec
  `--use-fake-ui-for-media-stream` et `--use-fake-device-for-media-stream`.
  Aucun microphone ni aucune caméra physiques ne sont utilisés.
- `MEET_E2E_URL` permet de remplacer l’URL locale par défaut
  `http://127.0.0.1:80/meet`.

## Conditions bloquantes

La commande retourne un code non nul et bloque la validation si :

- les deux participants ne reçoivent pas des pistes audio et vidéo actives ;
- les médias s’interrompent pendant le contrôle de stabilité ;
- l’appel ne reprend pas après la courte coupure réseau simulée ;
- la renégociation crée un participant distant en double ;
- la sortie volontaire n’est pas propagée à l’autre participant.