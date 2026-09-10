# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## Atlas des luthiers d'Europe

- Carte publique : `artifacts/novaluth/public/atlas/` (Leaflet, servi sur `/atlas/`), configurée par `window.NOVALUTH_ATLAS` dans `index.html` (`apiBase: '/'` car front et API partagent l'origine).
- API : `artifacts/api-server/src/routes/atlas.ts` — `GET /api/atlas/session`, `GET /api/atlas/luthiers` (lecture publique), `POST/PATCH/DELETE /api/atlas/luthiers` (administrateurs seulement, session `novaluth_platform_sessions` avec rôle `admin`, ou en-tête `X-Admin-Token`).
- Table : `novaluth_atlas_points` (`lib/db/src/schema/novaluth-atlas.ts`). Après un pull, exécuter `pnpm --filter @workspace/db run push`.
- Règle métier : une fiche `novaluth_profiles` au statut `publiee` apparaît automatiquement sur la carte ; ses coordonnées sont géocodées une fois (ville + pays, Photon/OpenStreetMap) puis mises en cache dans `novaluth_atlas_points`. Un administrateur peut affiner l'adresse, les instruments et les spécialisations, ou masquer un point. Les luthiers ne saisissent jamais sur la carte.
- Variables facultatives : `ATLAS_GEOCODAGE=off` pour désactiver le géocodage, `ATLAS_GEOCODAGE_URL` pour pointer un autre service.
