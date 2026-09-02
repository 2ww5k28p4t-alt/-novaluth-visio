"""Novaluth — migration vers le modele « Commande protegee ».

Ce que le script fait :

  1. Passe le prix d'acces aux projets a 0 EUR (les tranches disparaissent).
  2. Retire les carnets d'acces de la vente.
  3. Liste les soldes prepayes encore actifs et calcule le remboursement au
     prorata de la somme reellement payee, comme l'article 3 bis des CGV
     le prevoit deja.
  4. Cree les tables du nouveau modele.

Le script ne rembourse rien tout seul : il produit un fichier
data/remboursements_carnets.csv que vous traitez manuellement depuis votre
tableau de bord Stripe. C'est volontaire — un remboursement automatique en
masse est exactement le genre d'operation qu'il ne faut pas declencher depuis
un script lance sur un telephone.

Usage depuis le Shell du Repl :

    python -m tools.migration_commande_protegee --verifier    # lecture seule
    python -m tools.migration_commande_protegee --appliquer   # ecriture

A placer dans : novaluth/tools/migration_commande_protegee.py
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RACINE))

CHEMIN_BASE = RACINE / "data" / "novaluth.db"
SORTIE_CSV = RACINE / "data" / "remboursements_carnets.csv"
SAUVEGARDE = RACINE / "data" / f"novaluth-avant-migration-{datetime.now(timezone.utc):%Y%m%d-%H%M}.db"

# Correspondance prix paye / solde credite, telle qu'elle figurait dans
# web/store_acces.py avant la migration.
CARNETS_HISTORIQUES = {
    7995: 6900,    # solde 79,95 EUR credite pour 69,00 EUR payes
    15990: 11900,  # solde 159,90 EUR credite pour 119,00 EUR payes
}


def _connexion() -> sqlite3.Connection:
    conn = sqlite3.connect(CHEMIN_BASE, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _table_existe(conn: sqlite3.Connection, nom: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (nom,)
    ).fetchone() is not None


def _colonnes(conn: sqlite3.Connection, table: str) -> set[str]:
    return {l["name"] for l in conn.execute(f"PRAGMA table_info({table})")}


# ---------------------------------------------------------------------------
# 1. Inventaire des soldes prepayes
# ---------------------------------------------------------------------------

def inventorier_soldes(conn: sqlite3.Connection) -> list[dict]:
    """Retourne les soldes actifs et le remboursement du a chaque atelier."""
    if not _table_existe(conn, "ateliers"):
        return []

    cols = _colonnes(conn, "ateliers")
    champ_solde = next((c for c in ("solde_cents", "solde", "solde_acces_cents")
                        if c in cols), None)
    if champ_solde is None:
        return []

    champ_courriel = next((c for c in ("courriel", "email", "adresse") if c in cols), "id")

    lignes = conn.execute(
        f"SELECT id, {champ_courriel} AS contact, {champ_solde} AS solde"
        f" FROM ateliers WHERE {champ_solde} > 0"
    ).fetchall()

    resultats = []
    for ligne in lignes:
        solde_restant = int(ligne["solde"])
        # Ratio de prudence : on rembourse au prorata de la somme reellement
        # payee. En l'absence d'historique d'achat precis, on applique le
        # ratio du carnet le plus favorable a l'atelier.
        meilleur_ratio = max(paye / credite for credite, paye in CARNETS_HISTORIQUES.items())
        remboursement = int(round(solde_restant * meilleur_ratio))
        resultats.append({
            "atelier_id": ligne["id"],
            "contact": ligne["contact"],
            "solde_restant_cents": solde_restant,
            "remboursement_cents": remboursement,
            "solde_restant_euros": f"{solde_restant / 100:.2f}",
            "remboursement_euros": f"{remboursement / 100:.2f}",
        })
    return resultats


def ecrire_csv(soldes: list[dict]) -> None:
    SORTIE_CSV.parent.mkdir(parents=True, exist_ok=True)
    champs = ["atelier_id", "contact", "solde_restant_cents", "solde_restant_euros",
              "remboursement_cents", "remboursement_euros"]
    with SORTIE_CSV.open("w", newline="", encoding="utf-8") as flux:
        redacteur = csv.DictWriter(flux, fieldnames=champs)
        redacteur.writeheader()
        for ligne in soldes:
            redacteur.writerow({c: ligne[c] for c in champs})


# ---------------------------------------------------------------------------
# 2. Mise a zero du prix d'acces
# ---------------------------------------------------------------------------

def annuler_autorisations_en_cours(conn: sqlite3.Connection) -> int:
    """Les demandes d'acces en attente deviennent gratuites : rien a debiter."""
    if not _table_existe(conn, "acces"):
        return 0
    cols = _colonnes(conn, "acces")
    if "etat" not in cols:
        return 0
    champ_prix = next((c for c in ("prix_cents", "montant_cents") if c in cols), None)

    if champ_prix:
        curseur = conn.execute(
            f"UPDATE acces SET {champ_prix}=0 WHERE etat IN ('en_attente','demande')"
        )
    else:
        curseur = conn.execute(
            "UPDATE acces SET etat='gratuit' WHERE etat IN ('en_attente','demande')"
        )
    return curseur.rowcount


def marquer_carnets_retires(conn: sqlite3.Connection) -> None:
    """Trace la fin de commercialisation des carnets."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS migrations (
            nom TEXT PRIMARY KEY,
            appliquee_le TEXT NOT NULL,
            detail TEXT
        )""")
    conn.execute(
        "INSERT OR REPLACE INTO migrations (nom, appliquee_le, detail) VALUES (?,?,?)",
        ("commande_protegee_v2",
         datetime.now(timezone.utc).isoformat(timespec="seconds"),
         "acces a 0 EUR, carnets retires de la vente, tables commandes creees"),
    )


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

def verifier() -> None:
    if not CHEMIN_BASE.exists():
        print(f"Base introuvable : {CHEMIN_BASE}")
        print("Lancez d'abord l'application une fois pour la creer.")
        return

    conn = _connexion()
    try:
        soldes = inventorier_soldes(conn)
        total_solde = sum(s["solde_restant_cents"] for s in soldes)
        total_rembours = sum(s["remboursement_cents"] for s in soldes)

        acces_attente = 0
        if _table_existe(conn, "acces"):
            ligne = conn.execute(
                "SELECT COUNT(*) AS n FROM acces WHERE etat IN ('en_attente','demande')"
            ).fetchone()
            acces_attente = int(ligne["n"])

        print("=== Verification, aucune ecriture ===")
        print(f"Base                        : {CHEMIN_BASE}")
        print(f"Ateliers avec solde actif   : {len(soldes)}")
        print(f"Solde total en circulation  : {total_solde / 100:.2f} EUR")
        print(f"Remboursement au prorata    : {total_rembours / 100:.2f} EUR")
        print(f"Demandes d'acces en attente : {acces_attente} (passeront a 0 EUR)")
        if soldes:
            print("\nDetail :")
            for s in soldes:
                print(f"  {s['atelier_id']:<24} {s['contact']:<32} "
                      f"solde {s['solde_restant_euros']:>8} EUR  "
                      f"a rembourser {s['remboursement_euros']:>8} EUR")
        print("\nRelancez avec --appliquer pour executer la migration.")
    finally:
        conn.close()


def appliquer() -> None:
    if not CHEMIN_BASE.exists():
        print(f"Base introuvable : {CHEMIN_BASE}")
        return

    import shutil
    shutil.copy2(CHEMIN_BASE, SAUVEGARDE)
    print(f"Sauvegarde ecrite : {SAUVEGARDE.name}")

    conn = _connexion()
    try:
        soldes = inventorier_soldes(conn)
        if soldes:
            ecrire_csv(soldes)
            print(f"Liste de remboursement ecrite : {SORTIE_CSV.name} "
                  f"({len(soldes)} atelier(s))")
        else:
            print("Aucun solde prepaye actif : rien a rembourser.")

        modifies = annuler_autorisations_en_cours(conn)
        print(f"Demandes d'acces passees a 0 EUR : {modifies}")

        marquer_carnets_retires(conn)
        conn.commit()
    finally:
        conn.close()

    from web import store_commandes
    store_commandes.initialiser()
    print("Tables « Commande protegee » creees.")

    print("\n=== A faire maintenant, a la main ===")
    print("1. Remboursez les soldes listes dans data/remboursements_carnets.csv")
    print("   depuis votre tableau de bord Stripe.")
    print("2. Retirez les carnets de l'espace atelier (templates/atelier.html).")
    print("3. Remplacez l'article 3 de legal/cgv.md par la nouvelle redaction.")
    print("4. Ajoutez le badge « Commande protegee » dans legal/badges.md.")
    print("5. Ecrivez aux ateliers concernes pour annoncer la gratuite de l'acces.")


def principal() -> None:
    analyseur = argparse.ArgumentParser(description="Migration Novaluth v2")
    groupe = analyseur.add_mutually_exclusive_group(required=True)
    groupe.add_argument("--verifier", action="store_true", help="lecture seule")
    groupe.add_argument("--appliquer", action="store_true", help="execute la migration")
    arguments = analyseur.parse_args()

    if arguments.verifier:
        verifier()
    else:
        appliquer()


if __name__ == "__main__":
    principal()
