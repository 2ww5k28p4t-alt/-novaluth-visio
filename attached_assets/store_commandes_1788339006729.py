"""Novaluth — modele « Commande protegee ».

Deux gachettes de facturation, et une seule regle :
l'atelier ne verse rien avant d'avoir lui-meme encaisse un acompte.

  1. Commande confirmee  -> frais d'engagement forfaitaires (29 EUR)
  2. Livraison confirmee -> commission de 2 %, plafonnee a 149 EUR

Ce module est autonome : il cree ses propres tables et n'exige aucune
modification de web/store_acces.py. Il se branche sur common/paiement.py
s'il existe, sinon il bascule sur un moteur simule qui journalise dans
data/paiements_simules.jsonl.

A placer dans : novaluth/web/store_commandes.py
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

# ---------------------------------------------------------------------------
# Reglages — tout se change ici. Si vous modifiez un montant, corrigez aussi
# l'article 3 de legal/cgv.md.
# ---------------------------------------------------------------------------

FRAIS_ENGAGEMENT_CENTS = 2900          # 29,00 EUR a la commande confirmee
TAUX_COMMISSION = 0.02                 # 2 % du prix de l'instrument
PLAFOND_COMMISSION_CENTS = 14900       # 149,00 EUR maximum
PLANCHER_COMMISSION_CENTS = 0          # pas de minimum : 0 si prix tres bas

DELAI_CONFIRMATION_COMMANDE_JOURS = 7  # le musicien confirme la commande
DELAI_CONFIRMATION_LIVRAISON_JOURS = 30  # apres la date de livraison annoncee
DELAI_RELANCE_LIVRAISON_JOURS = 7      # rappel avant expiration

# Etats possibles d'une commande.
ETATS = (
    "declaree",        # l'atelier a declare, le musicien n'a pas encore confirme
    "confirmee",       # double confirmation faite, 29 EUR encaisses
    "expiree",         # le musicien n'a pas confirme a temps, 0 EUR
    "refusee",         # le musicien dit qu'il n'a pas commande, 0 EUR
    "annulee_client",  # abandon du musicien apres confirmation, 29 EUR en credit
    "annulee_atelier", # abandon de l'atelier, 29 EUR acquis
    "livree",          # reception confirmee, commission due
    "non_confirmee",   # livraison jamais confirmee, commission remboursee
)

ETATS_FACTURES = {"confirmee", "annulee_atelier", "livree", "non_confirmee"}

RACINE = Path(__file__).resolve().parent.parent
CHEMIN_BASE = Path(os.environ.get("NOVALUTH_BASE", RACINE / "data" / "novaluth.db"))
JOURNAL_SIMULE = RACINE / "data" / "paiements_simules.jsonl"


# ---------------------------------------------------------------------------
# Connexion — reprend la convention de web/store.py : la connexion se referme
# en sortant du bloc, sinon le mode WAL epuise les descripteurs de fichier.
# ---------------------------------------------------------------------------

@contextmanager
def connexion() -> Iterator[sqlite3.Connection]:
    CHEMIN_BASE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CHEMIN_BASE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dans(jours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=jours)).isoformat(timespec="seconds")


def _echu(horodatage: str | None) -> bool:
    if not horodatage:
        return False
    return datetime.fromisoformat(horodatage) < datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Schema — cree si absent, ne touche a rien d'existant.
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS commandes (
    id                      TEXT PRIMARY KEY,
    projet_id               TEXT,
    atelier_id              TEXT NOT NULL,
    atelier_courriel        TEXT NOT NULL,
    musicien_courriel       TEXT NOT NULL,
    jeton_musicien          TEXT NOT NULL UNIQUE,
    jeton_livraison         TEXT NOT NULL UNIQUE,
    etat                    TEXT NOT NULL DEFAULT 'declaree',
    prix_instrument_cents   INTEGER NOT NULL,
    acompte_cents           INTEGER,
    devis_reference         TEXT,
    description             TEXT,
    date_livraison_annoncee TEXT,
    frais_engagement_cents  INTEGER NOT NULL,
    commission_cents        INTEGER NOT NULL DEFAULT 0,
    ref_autorisation        TEXT,
    ref_encaissement        TEXT,
    ref_commission          TEXT,
    credit_emis             INTEGER NOT NULL DEFAULT 0,
    cree_le                 TEXT NOT NULL,
    confirme_le             TEXT,
    livre_le                TEXT,
    clos_le                 TEXT,
    echeance_confirmation   TEXT,
    echeance_livraison      TEXT,
    relance_livraison_le    TEXT
);

CREATE INDEX IF NOT EXISTS idx_commandes_atelier ON commandes(atelier_id);
CREATE INDEX IF NOT EXISTS idx_commandes_etat    ON commandes(etat);

CREATE TABLE IF NOT EXISTS commandes_journal (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    commande_id  TEXT NOT NULL,
    horodatage   TEXT NOT NULL,
    evenement    TEXT NOT NULL,
    detail       TEXT,
    montant_cents INTEGER
);

CREATE INDEX IF NOT EXISTS idx_journal_commande ON commandes_journal(commande_id);

-- Credits d'annulation : les 29 EUR rendus quand le musicien annule.
CREATE TABLE IF NOT EXISTS credits_engagement (
    id           TEXT PRIMARY KEY,
    atelier_id   TEXT NOT NULL,
    montant_cents INTEGER NOT NULL,
    origine      TEXT,
    cree_le      TEXT NOT NULL,
    consomme_le  TEXT,
    commande_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_credits_atelier ON credits_engagement(atelier_id);
"""


def initialiser() -> None:
    """Idempotent : appele au demarrage de l'application."""
    with connexion() as conn:
        conn.executescript(SCHEMA)


def _tracer(conn: sqlite3.Connection, commande_id: str, evenement: str,
            detail: str = "", montant_cents: int | None = None) -> None:
    conn.execute(
        "INSERT INTO commandes_journal (commande_id, horodatage, evenement, detail, montant_cents)"
        " VALUES (?,?,?,?,?)",
        (commande_id, maintenant(), evenement, detail, montant_cents),
    )


# ---------------------------------------------------------------------------
# Moteur de paiement — adaptateur. On reutilise common/paiement.py s'il expose
# des fonctions compatibles, sinon on journalise en mode simule.
# ---------------------------------------------------------------------------

class MoteurPaiement:
    """Trois operations seulement : retenir, encaisser, liberer."""

    def __init__(self) -> None:
        self.mode = os.environ.get("NOVALUTH_PAIEMENT", "simule").strip().lower()
        self._delegue = self._charger_delegue()

    @staticmethod
    def _charger_delegue() -> Any:
        try:
            from common import paiement as _p  # type: ignore
        except Exception:
            return None
        attendus = ("autoriser", "encaisser", "annuler")
        if all(hasattr(_p, n) for n in attendus):
            return _p
        # Tolerance sur les noms alternatifs utilises dans la v1.
        alternatifs = ("preautoriser", "capturer", "liberer")
        if all(hasattr(_p, n) for n in alternatifs):
            class _Pont:
                autoriser = staticmethod(_p.preautoriser)   # type: ignore[attr-defined]
                encaisser = staticmethod(_p.capturer)       # type: ignore[attr-defined]
                annuler = staticmethod(_p.liberer)          # type: ignore[attr-defined]
            return _Pont
        return None

    def _journaliser(self, operation: str, reference: str, montant_cents: int,
                     etiquette: str) -> None:
        JOURNAL_SIMULE.parent.mkdir(parents=True, exist_ok=True)
        ligne = {
            "horodatage": maintenant(),
            "operation": operation,
            "reference": reference,
            "montant_cents": montant_cents,
            "etiquette": etiquette,
        }
        with JOURNAL_SIMULE.open("a", encoding="utf-8") as flux:
            flux.write(json.dumps(ligne, ensure_ascii=False) + "\n")

    def autoriser(self, atelier_id: str, montant_cents: int, etiquette: str) -> str:
        if self._delegue is not None:
            return str(self._delegue.autoriser(atelier_id, montant_cents, etiquette))
        reference = "auth_" + secrets.token_hex(8)
        self._journaliser("preautorisation", reference, montant_cents, etiquette)
        return reference

    def encaisser(self, reference: str, montant_cents: int, etiquette: str) -> str:
        if self._delegue is not None:
            return str(self._delegue.encaisser(reference, montant_cents))
        self._journaliser("encaissement", reference, montant_cents, etiquette)
        return reference

    def annuler(self, reference: str, etiquette: str) -> None:
        if self._delegue is not None:
            self._delegue.annuler(reference)
            return
        self._journaliser("annulation", reference, 0, etiquette)

    def rembourser(self, reference: str, montant_cents: int, etiquette: str) -> None:
        if self._delegue is not None and hasattr(self._delegue, "rembourser"):
            self._delegue.rembourser(reference, montant_cents)  # type: ignore[attr-defined]
            return
        self._journaliser("remboursement", reference, montant_cents, etiquette)


MOTEUR = MoteurPaiement()


# ---------------------------------------------------------------------------
# Calcul de la commission
# ---------------------------------------------------------------------------

def commission_pour(prix_instrument_cents: int) -> int:
    """2 % du prix, plafonnee a 149 EUR. Jamais negative."""
    if prix_instrument_cents <= 0:
        return 0
    brut = int(round(prix_instrument_cents * TAUX_COMMISSION))
    return max(PLANCHER_COMMISSION_CENTS, min(brut, PLAFOND_COMMISSION_CENTS))


def total_novaluth(prix_instrument_cents: int) -> int:
    return FRAIS_ENGAGEMENT_CENTS + commission_pour(prix_instrument_cents)


def euros(cents: int) -> str:
    return f"{cents / 100:.2f} EUR".replace(".", ",")


# ---------------------------------------------------------------------------
# Gachette 1 — declaration puis confirmation de la commande
# ---------------------------------------------------------------------------

def declarer_commande(*, atelier_id: str, atelier_courriel: str,
                      musicien_courriel: str, prix_instrument_cents: int,
                      acompte_cents: int | None = None,
                      projet_id: str | None = None,
                      devis_reference: str | None = None,
                      description: str | None = None,
                      date_livraison_annoncee: str | None = None) -> dict[str, Any]:
    """L'atelier declare une commande. Rien n'est debite a ce stade."""
    if prix_instrument_cents <= 0:
        raise ValueError("Le prix de l'instrument doit etre renseigne.")

    commande_id = uuid.uuid4().hex
    jeton_musicien = secrets.token_urlsafe(24)
    jeton_livraison = secrets.token_urlsafe(24)

    with connexion() as conn:
        doublon = conn.execute(
            "SELECT id FROM commandes WHERE atelier_id=? AND musicien_courriel=?"
            " AND etat IN ('declaree','confirmee')",
            (atelier_id, musicien_courriel.strip().lower()),
        ).fetchone()
        if doublon:
            raise ValueError("Une commande est deja ouverte avec ce musicien.")

        conn.execute(
            "INSERT INTO commandes (id, projet_id, atelier_id, atelier_courriel,"
            " musicien_courriel, jeton_musicien, jeton_livraison, etat,"
            " prix_instrument_cents, acompte_cents, devis_reference, description,"
            " date_livraison_annoncee, frais_engagement_cents, commission_cents,"
            " cree_le, echeance_confirmation)"
            " VALUES (?,?,?,?,?,?,?,'declaree',?,?,?,?,?,?,?,?,?)",
            (commande_id, projet_id, atelier_id, atelier_courriel.strip().lower(),
             musicien_courriel.strip().lower(), jeton_musicien, jeton_livraison,
             prix_instrument_cents, acompte_cents, devis_reference, description,
             date_livraison_annoncee, FRAIS_ENGAGEMENT_CENTS,
             commission_pour(prix_instrument_cents), maintenant(),
             _dans(DELAI_CONFIRMATION_COMMANDE_JOURS)),
        )
        _tracer(conn, commande_id, "declaration",
                f"atelier={atelier_id} prix={euros(prix_instrument_cents)}")

    return {
        "commande_id": commande_id,
        "jeton_musicien": jeton_musicien,
        "frais_engagement_cents": FRAIS_ENGAGEMENT_CENTS,
        "commission_prevue_cents": commission_pour(prix_instrument_cents),
    }


def lire_commande(commande_id: str) -> dict[str, Any] | None:
    with connexion() as conn:
        ligne = conn.execute("SELECT * FROM commandes WHERE id=?", (commande_id,)).fetchone()
    return dict(ligne) if ligne else None


def lire_par_jeton(jeton: str, champ: str = "jeton_musicien") -> dict[str, Any] | None:
    if champ not in ("jeton_musicien", "jeton_livraison"):
        raise ValueError("Jeton inconnu.")
    with connexion() as conn:
        ligne = conn.execute(
            f"SELECT * FROM commandes WHERE {champ}=?", (jeton,)
        ).fetchone()
    return dict(ligne) if ligne else None


def confirmer_commande(jeton_musicien: str) -> dict[str, Any]:
    """Le musicien confirme : c'est le fait generateur des 29 EUR."""
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM commandes WHERE jeton_musicien=?", (jeton_musicien,)
        ).fetchone()
        if ligne is None:
            raise ValueError("Commande introuvable.")
        commande = dict(ligne)

        if commande["etat"] != "declaree":
            return commande
        if _echu(commande["echeance_confirmation"]):
            conn.execute(
                "UPDATE commandes SET etat='expiree', clos_le=? WHERE id=?",
                (maintenant(), commande["id"]),
            )
            _tracer(conn, commande["id"], "expiration", "confirmation hors delai", 0)
            commande["etat"] = "expiree"
            return commande

        credit = conn.execute(
            "SELECT id, montant_cents FROM credits_engagement"
            " WHERE atelier_id=? AND consomme_le IS NULL ORDER BY cree_le LIMIT 1",
            (commande["atelier_id"],),
        ).fetchone()

        if credit is not None and credit["montant_cents"] >= FRAIS_ENGAGEMENT_CENTS:
            conn.execute(
                "UPDATE credits_engagement SET consomme_le=?, commande_id=? WHERE id=?",
                (maintenant(), commande["id"], credit["id"]),
            )
            reference = "credit:" + credit["id"]
            _tracer(conn, commande["id"], "engagement_par_credit",
                    "credit d'annulation utilise", FRAIS_ENGAGEMENT_CENTS)
        else:
            etiquette = f"Novaluth engagement {commande['id'][:8]}"
            reference = MOTEUR.autoriser(commande["atelier_id"],
                                         FRAIS_ENGAGEMENT_CENTS, etiquette)
            reference = MOTEUR.encaisser(reference, FRAIS_ENGAGEMENT_CENTS, etiquette)
            _tracer(conn, commande["id"], "engagement_encaisse",
                    reference, FRAIS_ENGAGEMENT_CENTS)

        echeance = None
        if commande["date_livraison_annoncee"]:
            try:
                base = datetime.fromisoformat(commande["date_livraison_annoncee"])
                if base.tzinfo is None:
                    base = base.replace(tzinfo=timezone.utc)
                echeance = (base + timedelta(days=DELAI_CONFIRMATION_LIVRAISON_JOURS)) \
                    .isoformat(timespec="seconds")
            except ValueError:
                echeance = None

        conn.execute(
            "UPDATE commandes SET etat='confirmee', confirme_le=?,"
            " ref_encaissement=?, echeance_livraison=? WHERE id=?",
            (maintenant(), reference, echeance, commande["id"]),
        )
        commande.update(etat="confirmee", ref_encaissement=reference)

        # Le projet se ferme aux autres ateliers : plus de devis gratuit dans le vide.
        if commande["projet_id"]:
            try:
                conn.execute(
                    "UPDATE projets SET etat='attribue' WHERE id=?",
                    (commande["projet_id"],),
                )
            except sqlite3.OperationalError:
                pass  # schema projets different : on n'echoue pas pour autant

    return commande


def refuser_commande(jeton_musicien: str, motif: str = "") -> dict[str, Any]:
    """Le musicien indique qu'il n'a pas commande : 0 EUR."""
    return _clore(jeton_musicien, "refusee", motif or "refus du musicien")


def annuler_par_client(commande_id: str, motif: str = "") -> dict[str, Any]:
    """Abandon du musicien apres confirmation : les 29 EUR reviennent en credit."""
    with connexion() as conn:
        ligne = conn.execute("SELECT * FROM commandes WHERE id=?", (commande_id,)).fetchone()
        if ligne is None:
            raise ValueError("Commande introuvable.")
        commande = dict(ligne)
        if commande["etat"] != "confirmee":
            raise ValueError("Seule une commande confirmee peut etre annulee ainsi.")

        conn.execute(
            "INSERT INTO credits_engagement (id, atelier_id, montant_cents, origine, cree_le)"
            " VALUES (?,?,?,?,?)",
            (uuid.uuid4().hex, commande["atelier_id"], FRAIS_ENGAGEMENT_CENTS,
             f"annulation client {commande_id[:8]}", maintenant()),
        )
        conn.execute(
            "UPDATE commandes SET etat='annulee_client', clos_le=?, credit_emis=1 WHERE id=?",
            (maintenant(), commande_id),
        )
        _tracer(conn, commande_id, "annulation_client",
                motif or "abandon du musicien", FRAIS_ENGAGEMENT_CENTS)
        commande["etat"] = "annulee_client"
    return commande


def annuler_par_atelier(commande_id: str, motif: str = "") -> dict[str, Any]:
    """Abandon de l'atelier : les 29 EUR restent acquis, aucune commission."""
    with connexion() as conn:
        conn.execute(
            "UPDATE commandes SET etat='annulee_atelier', clos_le=? WHERE id=?",
            (maintenant(), commande_id),
        )
        _tracer(conn, commande_id, "annulation_atelier", motif or "abandon de l'atelier", 0)
    return lire_commande(commande_id) or {}


def _clore(jeton: str, etat: str, detail: str) -> dict[str, Any]:
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM commandes WHERE jeton_musicien=?", (jeton,)
        ).fetchone()
        if ligne is None:
            raise ValueError("Commande introuvable.")
        commande = dict(ligne)
        if commande["etat"] == "declaree":
            conn.execute(
                "UPDATE commandes SET etat=?, clos_le=? WHERE id=?",
                (etat, maintenant(), commande["id"]),
            )
            _tracer(conn, commande["id"], etat, detail, 0)
            commande["etat"] = etat
    return commande


# ---------------------------------------------------------------------------
# Gachette 2 — confirmation de livraison
# ---------------------------------------------------------------------------

def confirmer_livraison(jeton_livraison: str) -> dict[str, Any]:
    """Le musicien confirme la reception : la commission devient exigible."""
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM commandes WHERE jeton_livraison=?", (jeton_livraison,)
        ).fetchone()
        if ligne is None:
            raise ValueError("Commande introuvable.")
        commande = dict(ligne)

        if commande["etat"] == "livree":
            return commande
        if commande["etat"] != "confirmee":
            raise ValueError("Cette commande n'est pas en cours de fabrication.")

        montant = commission_pour(commande["prix_instrument_cents"])
        reference = None
        if montant > 0:
            etiquette = f"Novaluth commission {commande['id'][:8]}"
            reference = MOTEUR.autoriser(commande["atelier_id"], montant, etiquette)
            reference = MOTEUR.encaisser(reference, montant, etiquette)

        conn.execute(
            "UPDATE commandes SET etat='livree', livre_le=?, clos_le=?,"
            " commission_cents=?, ref_commission=? WHERE id=?",
            (maintenant(), maintenant(), montant, reference, commande["id"]),
        )
        _tracer(conn, commande["id"], "livraison_confirmee", reference or "", montant)
        commande.update(etat="livree", commission_cents=montant)

    return commande


def cloturer_sans_confirmation(commande_id: str) -> dict[str, Any]:
    """Livraison jamais confirmee dans les delais : aucune commission due."""
    with connexion() as conn:
        conn.execute(
            "UPDATE commandes SET etat='non_confirmee', clos_le=?, commission_cents=0"
            " WHERE id=?",
            (maintenant(), commande_id),
        )
        _tracer(conn, commande_id, "livraison_non_confirmee",
                "commission non due, echeance depassee", 0)
    return lire_commande(commande_id) or {}


# ---------------------------------------------------------------------------
# Taches quotidiennes — a appeler depuis web/taches.py
# ---------------------------------------------------------------------------

def executer_taches() -> dict[str, int]:
    """Expirations et cloture des livraisons non confirmees."""
    bilan = {"confirmations_expirees": 0, "livraisons_non_confirmees": 0, "relances": 0}

    with connexion() as conn:
        expirees = conn.execute(
            "SELECT id FROM commandes WHERE etat='declaree' AND echeance_confirmation < ?",
            (maintenant(),),
        ).fetchall()
        for ligne in expirees:
            conn.execute(
                "UPDATE commandes SET etat='expiree', clos_le=? WHERE id=?",
                (maintenant(), ligne["id"]),
            )
            _tracer(conn, ligne["id"], "expiration", "aucune confirmation du musicien", 0)
            bilan["confirmations_expirees"] += 1

        a_relancer = conn.execute(
            "SELECT id FROM commandes WHERE etat='confirmee'"
            " AND echeance_livraison IS NOT NULL"
            " AND echeance_livraison < ? AND relance_livraison_le IS NULL",
            (_dans(DELAI_RELANCE_LIVRAISON_JOURS),),
        ).fetchall()
        for ligne in a_relancer:
            conn.execute(
                "UPDATE commandes SET relance_livraison_le=? WHERE id=?",
                (maintenant(), ligne["id"]),
            )
            _tracer(conn, ligne["id"], "relance_livraison", "rappel envoye", 0)
            bilan["relances"] += 1

        perimees = conn.execute(
            "SELECT id FROM commandes WHERE etat='confirmee'"
            " AND echeance_livraison IS NOT NULL AND echeance_livraison < ?",
            (maintenant(),),
        ).fetchall()

    for ligne in perimees:
        cloturer_sans_confirmation(ligne["id"])
        bilan["livraisons_non_confirmees"] += 1

    return bilan


# ---------------------------------------------------------------------------
# Lectures pour l'espace atelier
# ---------------------------------------------------------------------------

def commandes_atelier(atelier_id: str) -> list[dict[str, Any]]:
    with connexion() as conn:
        lignes = conn.execute(
            "SELECT * FROM commandes WHERE atelier_id=? ORDER BY cree_le DESC",
            (atelier_id,),
        ).fetchall()
    return [dict(l) for l in lignes]


def credits_disponibles(atelier_id: str) -> int:
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT COALESCE(SUM(montant_cents),0) AS total FROM credits_engagement"
            " WHERE atelier_id=? AND consomme_le IS NULL",
            (atelier_id,),
        ).fetchone()
    return int(ligne["total"])


def statistiques() -> dict[str, Any]:
    """Chiffres de supervision. Aucune note, aucun classement de merite."""
    with connexion() as conn:
        lignes = conn.execute(
            "SELECT etat, COUNT(*) AS nb,"
            " COALESCE(SUM(CASE WHEN etat IN ('confirmee','annulee_atelier','livree',"
            " 'non_confirmee') THEN frais_engagement_cents ELSE 0 END),0) AS engagement,"
            " COALESCE(SUM(commission_cents),0) AS commission"
            " FROM commandes GROUP BY etat"
        ).fetchall()

    par_etat = {l["etat"]: l["nb"] for l in lignes}
    engagement = sum(l["engagement"] for l in lignes)
    commission = sum(l["commission"] for l in lignes)
    return {
        "par_etat": par_etat,
        "revenu_engagement_cents": engagement,
        "revenu_commission_cents": commission,
        "revenu_total_cents": engagement + commission,
        "commandes_livrees": par_etat.get("livree", 0),
    }


if __name__ == "__main__":
    initialiser()
    print("Tables « Commande protegee » pretes.")
    print("Frais d'engagement :", euros(FRAIS_ENGAGEMENT_CENTS))
    for prix in (90000, 250000, 350000, 800000, 1500000):
        print(f"  prix {euros(prix):>14}  ->  commission {euros(commission_pour(prix)):>10}"
              f"  total {euros(total_novaluth(prix)):>10}")
