import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { novaluthProfilesTable } from "./novaluth";

/**
 * Points de l'Atlas des luthiers d'Europe.
 *
 * Deux origines possibles :
 *  - "novaluth" : le point est rattaché à une fiche publiée (slug renseigné).
 *    Il est créé automatiquement à la première synchronisation de la carte,
 *    à partir de la ville et du pays de la fiche, puis peut être affiné.
 *  - "manuel"   : point saisi par un administrateur, sans dossier NovaLuth.
 *
 * Les luthiers ne saisissent jamais ici : ils passent par leur dossier.
 */
export const novaluthAtlasPointsTable = pgTable(
  "novaluth_atlas_points",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    slug: text("slug").references(() => novaluthProfilesTable.slug, {
      onDelete: "cascade",
    }),
    nom: text("nom").notNull(),
    pays: text("pays").notNull(),
    ville: text("ville"),
    adresse: text("adresse"),
    instruments: text("instruments"),
    specialisations: text("specialisations"),
    telephone: text("telephone"),
    email: text("email"),
    siteWeb: text("site_web"),
    association: text("association"),
    sourceUrl: text("source_url"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    precisionGeo: text("precision_geo").notNull().default("adresse"),
    origine: text("origine").notNull().default("manuel"),
    masque: boolean("masque").notNull().default(false),
    creePar: text("cree_par"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("novaluth_atlas_points_slug_unique").on(table.slug),
  ],
);

export const insertNovaluthAtlasPointSchema = createInsertSchema(
  novaluthAtlasPointsTable,
).omit({ createdAt: true, updatedAt: true });

export type NovaluthAtlasPoint = typeof novaluthAtlasPointsTable.$inferSelect;
export type InsertNovaluthAtlasPoint = z.infer<
  typeof insertNovaluthAtlasPointSchema
>;
