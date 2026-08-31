import assert from "node:assert/strict";
import test from "node:test";
import { readLocalCollection } from "./local-collecte";

test("reads and normalizes manually entered luthiers", async () => {
  const [fiche] = await readLocalCollection(
    new Date("2026-08-31T10:00:00.000Z"),
  );

  assert.ok(fiche);
  assert.equal(fiche.slug, "atelier-clairiere");
  assert.equal(fiche.statut, "candidate");
  assert.deepEqual(fiche.source_donnees, [
    "saisie manuelle",
    "catalogue interne NovaLuth",
  ]);
  assert.equal(fiche.demonstration, false);
  assert.equal(fiche.cree_le, "2026-08-31T10:00:00.000Z");
  assert.equal(fiche.provenance_facons, "saisie manuelle");
  assert.ok(fiche.facons_travail.includes("atelier_une_personne"));
  assert.ok(fiche.facons_travail.includes("personnalisation_complete"));
});
