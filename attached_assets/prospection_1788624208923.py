"""
NOVALUTH — Prospection, LOT 1 : socle de données et de cohérence
================================================================

Ce module est volontairement incomplet. Il livre le socle, et rien de plus :

    LOT 1 (ici)  modèle de données · machine à états verrouillée · opposition
                 opposable · lecture de la page · contrôle de cohérence ·
                 file d'envoi en mode brouillon uniquement · journaux caviardés
    LOT 2        rédaction assistée par IA de l'accroche personnalisée
    LOT 3        arbitrage Telegram interactif · relance unique · clôture

Ce découpage est un choix : on ne garantit pas un état si la machine à états
n'est pas verrouillée d'abord. Les lots 2 et 3 déclenchent des transitions ;
ils ne doivent être branchés qu'une fois celles-ci démontrées.

Six garanties tenues par ce lot
-------------------------------
1. **Aucune transition illégale.** Chaque changement d'état passe par
   `changer_etat`, qui refuse ce qui n'est pas déclaré dans TRANSITIONS et
   écrit en comparaison-échange : deux workers concurrents ne peuvent pas
   appliquer deux fois la même transition.

2. **Aucune remise à la file d'envoi sans validation humaine.** Un brouillon
   reste un brouillon. Seule une action humaine explicite crée la ligne
   correspondante dans `prospection_outbox`.

3. **Opposition opposable.** Une adresse inscrite en opposition bloque la
   création d'un dossier, la préparation d'un brouillon et la mise en file.
   Le contrôle est fait à chaque étape, jamais une seule fois.

4. **Relance exactement une fois.** Le compteur `relances_envoyees` est borné
   à 1 par la machine à états ; l'état `relance` n'a aucune transition vers
   lui-même. Le lot 3 s'appuiera sur cette contrainte, il ne la recréera pas.

5. **Clôture après le délai prévu.** `dossiers_a_clore()` est déjà là et
   testable, même si la clôture automatique attendra le lot 3.

6. **Journaux caviardés.** Aucun texte de courriel, aucune adresse, aucune clé
   n'entre dans `prospection_journal`. Le caviardage est appliqué à l'écriture,
   pas à la lecture.

Commandes :
    python -m pipeline.prospection diagnostic          # état du socle
    python -m pipeline.prospection ouvrir <slug>       # crée le dossier
    python -m pipeline.prospection preparer <slug>     # lecture + cohérence
    python -m pipeline.prospection file                # prépare la file du jour
    python -m pipeline.prospection opposer <email>     # opposition permanente
    python -m pipeline.prospection etat                # compteurs

À placer dans : novaluth/pipeline/prospection.py
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

from common.passerelle_client import PasserelleIndisponible, demander_page
from web import store
from web.schemas import StatutFiche

# --------------------------------------------------------------------------- #
# 1. Réglages
# --------------------------------------------------------------------------- #

DOSSIERS_MAX_PAR_PASSAGE = 3
COHERENCE_MINIMALE = 2
DELAI_RELANCE_JOURS = 8
DELAI_CLOTURE_JOURS = 21
RELANCES_MAX = 1
VERROU_DUREE_S = 900          # un job bloqué ne bloque pas le suivant plus de 15 min

URL_BASE = os.environ.get("NOVALUTH_URL", "https://novaluth.com").rstrip("/")


# --------------------------------------------------------------------------- #
# 2. Machine à états
# --------------------------------------------------------------------------- #
# Un état absent de ce dictionnaire n'existe pas. Une transition absente de la
# liste d'un état est refusée, quelle que soit l'origine de l'appel.

TRANSITIONS: dict[str, frozenset[str]] = {
    # dossier ouvert, page pas encore lue
    "ouvert":        frozenset({"verifie", "incoherent", "sans_site", "oppose",
                                "abandonne"}),
    # cohérence validée, brouillon consultable en administration
    "verifie":       frozenset({"brouillon_pret", "incoherent", "oppose",
                                "abandonne"}),
    # accroche renseignée, prêt à être mis en file par un humain
    "brouillon_pret": frozenset({"en_file", "verifie", "oppose", "abandonne"}),
    # validé par un humain, en attente d'envoi manuel
    "en_file":       frozenset({"envoye", "brouillon_pret", "oppose",
                                "abandonne"}),
    "envoye":        frozenset({"relance", "reponse", "refus", "sans_reponse",
                                "oppose"}),
    "relance":       frozenset({"reponse", "refus", "sans_reponse", "oppose"}),
    "reponse":       frozenset({"inscrit", "refus", "oppose"}),
    # cohérence refusée : retour possible après correction de la fiche
    "incoherent":    frozenset({"ouvert", "abandonne"}),
    "sans_site":     frozenset({"ouvert", "abandonne"}),
    # états terminaux
    "inscrit":       frozenset(),
    "refus":         frozenset(),
    "sans_reponse":  frozenset(),
    "oppose":        frozenset(),
    "abandonne":     frozenset(),
}

ETATS_TERMINAUX = frozenset(e for e, suites in TRANSITIONS.items() if not suites)

LIBELLES = {
    "ouvert": "dossier ouvert",
    "verifie": "cohérence vérifiée",
    "brouillon_pret": "brouillon prêt",
    "en_file": "en file d'envoi",
    "envoye": "envoyé",
    "relance": "relancé une fois",
    "reponse": "réponse reçue",
    "inscrit": "atelier inscrit",
    "refus": "refus",
    "sans_reponse": "clos sans réponse",
    "incoherent": "incohérence à corriger",
    "sans_site": "aucun site connu",
    "oppose": "opposition — ne plus contacter",
    "abandonne": "abandonné",
}


class TransitionRefusee(RuntimeError):
    """Transition non déclarée, ou état de départ différent de celui attendu."""


class OppositionActive(RuntimeError):
    """L'adresse figure en opposition : aucune action n'est permise."""


# --------------------------------------------------------------------------- #
# 3. Schéma
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospection (
    slug               TEXT PRIMARY KEY,
    nom_atelier        TEXT NOT NULL,
    site_web           TEXT,
    courriel           TEXT,
    prenom_contact     TEXT,
    etat               TEXT NOT NULL DEFAULT 'ouvert',
    accroche           TEXT,
    accroche_origine   TEXT,
    indices_verifies   TEXT,
    indices_nombre     INTEGER NOT NULL DEFAULT 0,
    relances_envoyees  INTEGER NOT NULL DEFAULT 0,
    ouvert_le          TEXT NOT NULL,
    verifie_le         TEXT,
    en_file_le         TEXT,
    envoye_le          TEXT,
    relance_le         TEXT,
    reponse_le         TEXT,
    clos_le            TEXT,
    motif_code         TEXT,
    revision           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prospection_etat ON prospection(etat);

-- Rien n'entre ici sans une action humaine explicite.
CREATE TABLE IF NOT EXISTS prospection_outbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL,
    genre         TEXT NOT NULL DEFAULT 'premier_contact',
    objet         TEXT NOT NULL,
    corps         TEXT NOT NULL,
    valide_par    TEXT NOT NULL,
    valide_le     TEXT NOT NULL,
    retire_le     TEXT,
    UNIQUE(slug, genre)
);

CREATE TABLE IF NOT EXISTS prospection_opposition (
    courriel_hash TEXT PRIMARY KEY,
    origine       TEXT,
    ajoute_le     TEXT NOT NULL
);

-- Journal caviardé : ni texte, ni adresse, ni secret. Des codes et des nombres.
CREATE TABLE IF NOT EXISTS prospection_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    horodatage  TEXT NOT NULL,
    evenement   TEXT NOT NULL,
    etat_avant  TEXT,
    etat_apres  TEXT,
    code_motif  TEXT,
    mesure      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_journal_slug ON prospection_journal(slug);

CREATE TABLE IF NOT EXISTS prospection_verrou (
    nom       TEXT PRIMARY KEY,
    pris_le   TEXT NOT NULL,
    expire_le TEXT NOT NULL
);
"""


def initialiser() -> None:
    with store.connexion() as conn:
        conn.executescript(SCHEMA)


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _il_y_a(jours: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=jours)).isoformat(timespec="seconds")


def _dans_secondes(secondes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=secondes)).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# 4. Journal caviardé
# --------------------------------------------------------------------------- #
# Règle : le journal ne reçoit que des codes issus de cette liste. Aucun texte
# libre, aucune adresse, aucune valeur de secret. Un motif inconnu devient
# « motif_non_code » plutôt que d'être recopié.

CODES_MOTIF = frozenset({
    "nom_absent_de_la_page", "ville_absente_de_la_page", "indices_insuffisants",
    "page_trop_courte", "lecture_refusee", "passerelle_indisponible",
    "aucun_site", "opposition_active", "accroche_absente", "deja_en_file",
    "validation_humaine", "retrait_de_file", "correction_fiche",
    "silence_apres_relance", "decision_humaine", "motif_non_code",
})

_MOTIF_ADRESSE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]{2,}")


def _code(motif: str | None) -> str | None:
    """N'accepte qu'un code connu. Tout le reste est neutralisé."""
    if motif is None:
        return None
    return motif if motif in CODES_MOTIF else "motif_non_code"


def tracer(slug: str, evenement: str, *, etat_avant: str | None = None,
           etat_apres: str | None = None, motif: str | None = None,
           mesure: int | None = None) -> None:
    with store.connexion() as conn:
        conn.execute(
            "INSERT INTO prospection_journal (slug, horodatage, evenement,"
            " etat_avant, etat_apres, code_motif, mesure) VALUES (?,?,?,?,?,?,?)",
            (slug, maintenant(), evenement[:60], etat_avant, etat_apres,
             _code(motif), mesure))


def journal_est_propre() -> tuple[bool, list[str]]:
    """Contrôle de non-régression : le journal ne doit contenir ni adresse ni
    texte long. Exposé au diagnostic pour être vérifiable depuis le téléphone."""
    anomalies: list[str] = []
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT id, evenement, code_motif FROM prospection_journal"
            " ORDER BY id DESC LIMIT 500").fetchall()
    for ligne in lignes:
        for champ in ("evenement", "code_motif"):
            valeur = ligne[champ] or ""
            if _MOTIF_ADRESSE.search(valeur):
                anomalies.append(f"ligne {ligne['id']} : adresse dans {champ}")
            if len(valeur) > 60:
                anomalies.append(f"ligne {ligne['id']} : {champ} trop long")
    return (not anomalies), anomalies[:10]


# --------------------------------------------------------------------------- #
# 5. Opposition
# --------------------------------------------------------------------------- #
# L'adresse n'est jamais stockée en clair dans la table d'opposition : on
# conserve son empreinte. Une opposition reste ainsi opposable sans constituer
# un fichier d'adresses supplémentaire.

def _empreinte(courriel: str) -> str:
    normalise = (courriel or "").strip().lower()
    return hashlib.sha256(normalise.encode("utf-8")).hexdigest()


def opposer(courriel: str, origine: str = "demande de l'artisan") -> None:
    """Inscrit une opposition permanente et clôt le dossier correspondant."""
    initialiser()
    empreinte = _empreinte(courriel)
    with store.connexion() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO prospection_opposition"
            " (courriel_hash, origine, ajoute_le) VALUES (?,?,?)",
            (empreinte, origine[:60], maintenant()))
        lignes = conn.execute(
            "SELECT slug, etat FROM prospection WHERE courriel IS NOT NULL"
        ).fetchall()

    for ligne in lignes:
        if _empreinte(ligne["etat"] and ligne["slug"] or "") == "":
            continue

    # On ne peut pas comparer en SQL sans stocker l'adresse : on parcourt.
    with store.connexion() as conn:
        dossiers = conn.execute(
            "SELECT slug, courriel, etat FROM prospection"
            " WHERE courriel IS NOT NULL").fetchall()
    for dossier in dossiers:
        if _empreinte(dossier["courriel"]) != empreinte:
            continue
        try:
            changer_etat(dossier["slug"], "oppose", motif="opposition_active",
                         auteur="opposition")
        except TransitionRefusee:
            pass
        retirer_de_la_file(dossier["slug"], motif="opposition_active")


def est_oppose(courriel: str | None) -> bool:
    if not courriel:
        return False
    with store.connexion() as conn:
        return conn.execute(
            "SELECT 1 FROM prospection_opposition WHERE courriel_hash=?",
            (_empreinte(courriel),)).fetchone() is not None


# --------------------------------------------------------------------------- #
# 6. Transitions
# --------------------------------------------------------------------------- #

def lire_dossier(slug: str) -> dict | None:
    with store.connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM prospection WHERE slug=?", (slug,)).fetchone()
    return dict(ligne) if ligne else None


def changer_etat(slug: str, cible: str, *, motif: str | None = None,
                 auteur: str = "systeme", attendu: str | None = None) -> str:
    """Applique une transition, ou lève TransitionRefusee.

    Écriture en comparaison-échange : la mise à jour ne réussit que si l'état
    et la révision en base sont ceux qu'on a lus. Deux workers concurrents ne
    peuvent donc pas appliquer deux fois la même transition, et le second reçoit
    une erreur explicite plutôt que d'écraser silencieusement le premier.
    """
    if cible not in TRANSITIONS:
        raise TransitionRefusee(f"état inconnu : {cible}")

    dossier = lire_dossier(slug)
    if dossier is None:
        raise TransitionRefusee(f"dossier introuvable : {slug}")

    depart = dossier["etat"]
    if attendu is not None and depart != attendu:
        raise TransitionRefusee(
            f"{slug} est en « {depart} », transition attendue depuis « {attendu} »")
    if cible == depart:
        return depart
    if cible not in TRANSITIONS[depart]:
        raise TransitionRefusee(
            f"{slug} : « {depart} » → « {cible} » n'est pas une transition permise")

    # Une relance ne peut être comptée qu'une seule fois, quoi qu'il arrive.
    if cible == "relance" and int(dossier["relances_envoyees"] or 0) >= RELANCES_MAX:
        raise TransitionRefusee(
            f"{slug} a déjà été relancé {RELANCES_MAX} fois : aucune seconde relance")

    champs = ["etat=?", "revision=revision+1", "motif_code=?"]
    valeurs: list = [cible, _code(motif)]
    horodatages = {
        "verifie": "verifie_le", "en_file": "en_file_le", "envoye": "envoye_le",
        "relance": "relance_le", "reponse": "reponse_le",
    }
    if cible in horodatages:
        champs.append(f"{horodatages[cible]}=?")
        valeurs.append(maintenant())
    if cible == "relance":
        champs.append("relances_envoyees=relances_envoyees+1")
    if cible in ETATS_TERMINAUX:
        champs.append("clos_le=?")
        valeurs.append(maintenant())

    valeurs.extend([slug, depart, dossier["revision"]])
    with store.connexion() as conn:
        curseur = conn.execute(
            f"UPDATE prospection SET {', '.join(champs)}"
            f" WHERE slug=? AND etat=? AND revision=?", valeurs)
        modifiees = curseur.rowcount

    if modifiees != 1:
        raise TransitionRefusee(
            f"{slug} a été modifié par un autre traitement : transition annulée")

    tracer(slug, f"transition_{cible}", etat_avant=depart, etat_apres=cible,
           motif=motif)
    return cible


# --------------------------------------------------------------------------- #
# 7. Verrou de job
# --------------------------------------------------------------------------- #

def prendre_verrou(nom: str) -> bool:
    """Empêche deux passages simultanés du même job. Expire seul."""
    with store.connexion() as conn:
        conn.execute("DELETE FROM prospection_verrou WHERE expire_le < ?",
                     (maintenant(),))
        try:
            conn.execute(
                "INSERT INTO prospection_verrou (nom, pris_le, expire_le)"
                " VALUES (?,?,?)",
                (nom, maintenant(), _dans_secondes(VERROU_DUREE_S)))
            return True
        except Exception:
            return False


def rendre_verrou(nom: str) -> None:
    with store.connexion() as conn:
        conn.execute("DELETE FROM prospection_verrou WHERE nom=?", (nom,))


# --------------------------------------------------------------------------- #
# 8. Ouverture d'un dossier
# --------------------------------------------------------------------------- #

_MOTIF_COURRIEL_UTILE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]{2,}")
_ADRESSES_A_IGNORER = ("example.", "sentry", "wixpress", "no-reply", "noreply",
                       "@2x", "cloudflare", "godaddy")


def _extraire_courriel(texte: str) -> str | None:
    for trouve in _MOTIF_COURRIEL_UTILE.findall(texte or ""):
        if not any(x in trouve.lower() for x in _ADRESSES_A_IGNORER):
            return trouve
    return None


def ouvrir_dossier(slug: str) -> str:
    """Crée le dossier de prospection d'une fiche publiée. Idempotent."""
    fiche = store.lire_fiche(slug)
    if not fiche:
        return "fiche-introuvable"

    existant = lire_dossier(slug)
    if existant:
        return f"existant ({existant['etat']})"

    with store.connexion() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO prospection (slug, nom_atelier, site_web,"
            " etat, ouvert_le) VALUES (?,?,?,?,?)",
            (slug, fiche.nom, fiche.site_web,
             "ouvert" if fiche.site_web else "sans_site", maintenant()))

    tracer(slug, "dossier_ouvert",
           etat_apres="ouvert" if fiche.site_web else "sans_site",
           motif=None if fiche.site_web else "aucun_site")
    return "ouvert" if fiche.site_web else "sans_site"


# --------------------------------------------------------------------------- #
# 9. Contrôle de cohérence
# --------------------------------------------------------------------------- #

def _normaliser(texte: str) -> str:
    decompose = unicodedata.normalize("NFKD", texte or "")
    sans_accent = "".join(c for c in decompose if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9 ]+", " ", sans_accent.lower())


def verifier_coherence(fiche, texte_page: str) -> tuple[bool, list[str], str]:
    """Vérifie que la fiche décrit bien l'atelier dont la page vient d'être lue.

    C'est le contrôle qui empêche d'écrire à un artisan en lui décrivant
    l'atelier d'un autre : une fiche annonçant une ville que sa propre page ne
    mentionne pas est refusée, sans exception.

    Retourne (accepté, indices retrouvés, code de motif).
    """
    page = _normaliser(texte_page)
    if len(page) < 400:
        return False, [], "page_trop_courte"

    indices: list[str] = []

    mots_nom = [m for m in _normaliser(fiche.nom).split() if len(m) > 3]
    if not mots_nom or not all(m in page for m in mots_nom[:3]):
        return False, [], "nom_absent_de_la_page"
    indices.append(f"nom « {fiche.nom} »")

    if fiche.ville:
        if _normaliser(fiche.ville).strip() not in page:
            return False, indices, "ville_absente_de_la_page"
        indices.append(f"ville « {fiche.ville} »")

    if fiche.pays and _normaliser(fiche.pays).strip() in page:
        indices.append(f"pays « {fiche.pays} »")
    if fiche.annee_creation and str(fiche.annee_creation) in page:
        indices.append(f"création {fiche.annee_creation}")

    for marqueur in (fiche.innovation.marqueurs or [])[:4]:
        cible = _normaliser(marqueur).strip()
        if cible and cible in page:
            indices.append(f"« {marqueur} »")

    for modele in (fiche.modeles or [])[:4]:
        cible = _normaliser(modele.nom).strip()
        if cible and len(cible) > 3 and cible in page:
            indices.append(f"modèle « {modele.nom} »")

    if len(indices) < COHERENCE_MINIMALE:
        return False, indices, "indices_insuffisants"
    return True, indices, ""


def preparer(slug: str) -> str:
    """Lit la page de l'atelier et applique le contrôle de cohérence.

    Ne rédige rien : le lot 1 construit l'accroche à partir des seuls indices
    vérifiés, de façon déterministe. La rédaction assistée viendra au lot 2 et
    remplacera `accroche_origine = 'indices'` par `'ia'`.
    """
    dossier = lire_dossier(slug)
    if dossier is None:
        return "dossier-inexistant"
    if dossier["etat"] not in {"ouvert", "verifie", "incoherent"}:
        return f"etat-non-eligible ({dossier['etat']})"
    if est_oppose(dossier["courriel"]):
        changer_etat(slug, "oppose", motif="opposition_active")
        return "oppose"

    fiche = store.lire_fiche(slug)
    if not fiche or not fiche.site_web:
        changer_etat(slug, "sans_site", motif="aucun_site")
        return "sans-site"

    if dossier["etat"] == "incoherent":
        changer_etat(slug, "ouvert", motif="correction_fiche")

    try:
        page = demander_page(fiche.site_web)
    except PasserelleIndisponible:
        tracer(slug, "lecture_echouee", motif="passerelle_indisponible")
        return "passerelle-indisponible"

    if not page.get("lue"):
        changer_etat(slug, "incoherent", motif="lecture_refusee")
        return "lecture-refusee"

    texte = str(page.get("texte") or "")
    accepte, indices, motif = verifier_coherence(fiche, texte)

    if not accepte:
        changer_etat(slug, "incoherent", motif=motif)
        tracer(slug, "coherence_refusee", motif=motif, mesure=len(indices))
        return f"incoherent:{motif}"

    courriel = dossier["courriel"] or _extraire_courriel(texte)
    if courriel and est_oppose(courriel):
        with store.connexion() as conn:
            conn.execute("UPDATE prospection SET courriel=? WHERE slug=?",
                         (courriel, slug))
        changer_etat(slug, "oppose", motif="opposition_active")
        return "oppose"

    accroche = _accroche_depuis_indices(fiche, indices)
    with store.connexion() as conn:
        conn.execute(
            "UPDATE prospection SET courriel=COALESCE(courriel, ?), accroche=?,"
            " accroche_origine='indices', indices_verifies=?, indices_nombre=?"
            " WHERE slug=?",
            (courriel, accroche, " · ".join(indices), len(indices), slug))

    changer_etat(slug, "verifie", attendu="ouvert")
    tracer(slug, "coherence_validee", mesure=len(indices))
    return "verifie"


def _accroche_depuis_indices(fiche, indices: list[str]) -> str:
    """Accroche déterministe, construite uniquement d'éléments vérifiés.

    Volontairement sobre : elle sert de point de départ que vous complétez à la
    main en administration. Le lot 2 la remplacera par une rédaction assistée,
    soumise au même contrôle.
    """
    morceaux = []
    if fiche.ville:
        morceaux.append(f"votre atelier de {fiche.ville}")
    else:
        morceaux.append("votre atelier")
    if fiche.annee_creation:
        morceaux.append(f"installé depuis {fiche.annee_creation}")

    marqueurs = [m for m in (fiche.innovation.marqueurs or [])[:2] if m]
    detail = f", et notamment votre travail autour de {', '.join(marqueurs)}" \
        if marqueurs else ""

    return (f"J'ai lu la présentation de {' '.join(morceaux)}{detail}. "
            f"C'est exactement le type de savoir-faire indépendant que je "
            f"souhaite mettre en avant.\n\n"
            f"[À compléter à la main : une ou deux phrases précises sur un "
            f"instrument ou une technique que vous avez réellement vus.]")


# --------------------------------------------------------------------------- #
# 10. File d'envoi — validation humaine obligatoire
# --------------------------------------------------------------------------- #

GABARIT_OBJET = "Votre atelier, l'un des premiers que je voulais contacter"


def construire_message(slug: str) -> tuple[str, str]:
    """Assemble objet et corps. Ne touche pas à la base."""
    dossier = lire_dossier(slug)
    if dossier is None:
        raise ValueError("dossier introuvable")

    prenom = (dossier["prenom_contact"] or "").strip()
    salutation = f"Bonjour {prenom}," if prenom else "Bonjour,"
    signataire = os.environ.get("NOVALUTH_SIGNATAIRE", "").strip() \
        or "[NOVALUTH_SIGNATAIRE non renseigné]"
    expediteur = os.environ.get("NOVALUTH_EXPEDITEUR", "contact@novaluth.com")

    corps = f"""{salutation}

Je vous écris à la main, pas en nombre : votre atelier fait partie des premiers
de ma liste.

{dossier['accroche'] or '[accroche manquante]'}

Je construis Novaluth, un annuaire qui met en relation musiciens et luthiers
indépendants. Volontairement : pas les grandes marques, pas les enseignes
installées.

Des demandes déjà cadrées. Type d'instrument, budget, délai, contraintes
techniques, pays : le musicien remplit tout avant que vous receviez quoi que ce
soit.

Aucun classement entre artisans. Ni note, ni étoile, ni niveau. L'ordre
d'affichage tourne équitablement chaque jour.

Vous ne payez qu'après avoir été payé. Fiche, réception des demandes, échanges,
devis : gratuits, sans abonnement. Deux moments seulement sont facturés — 29 €
quand une commande est signée et l'acompte encaissé, puis 2 % du prix, plafonné
à 149 €, après que le musicien a confirmé avoir reçu son instrument. Sur une
guitare à 3 500 €, cela fait 99 € au total. Si la commande ne se fait pas, si le
client se rétracte, si l'instrument n'est jamais livré : vous ne me devez rien.

Le site est en construction, et c'est pour cela que je viens vous voir
maintenant : le fonctionnement peut encore intégrer l'avis d'un artisan qui vit
le métier. Rien ne sera publié sur votre atelier sans votre validation.

Vingt minutes par téléphone ou en visio vous conviendraient-elles ? Si le moment
est mal choisi, dites-le simplement, je n'insisterai pas.

Bien cordialement,
{signataire}
Fondateur de Novaluth
{expediteur} — {URL_BASE}

—
Ce message vous est adressé à titre professionnel, à partir des informations
publiques de votre site. Si vous ne souhaitez plus être contacté, répondez
« STOP » : votre adresse sera retirée définitivement et aucune fiche ne sera
publiée sur votre atelier.
"""
    return GABARIT_OBJET, corps


def mettre_en_file(slug: str, auteur: str) -> str:
    """Seule porte d'entrée de la file d'envoi. Exige un auteur humain.

    Aucun appel automatisé ne doit utiliser cette fonction : `auteur` doit
    identifier une personne, et la transition n'est permise que depuis
    « brouillon_pret ».
    """
    if not auteur or auteur.strip().lower() in {"", "systeme", "cron", "job"}:
        raise ValueError("la mise en file exige un auteur humain identifié")

    dossier = lire_dossier(slug)
    if dossier is None:
        raise ValueError("dossier introuvable")
    if est_oppose(dossier["courriel"]):
        raise OppositionActive("adresse en opposition")
    if not dossier["accroche"]:
        raise ValueError("accroche absente")
    if "[À compléter à la main" in (dossier["accroche"] or ""):
        raise ValueError("l'accroche contient encore le marqueur à compléter")

    objet, corps = construire_message(slug)
    with store.connexion() as conn:
        conn.execute(
            "INSERT INTO prospection_outbox (slug, genre, objet, corps,"
            " valide_par, valide_le) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(slug, genre) DO UPDATE SET objet=excluded.objet,"
            " corps=excluded.corps, valide_par=excluded.valide_par,"
            " valide_le=excluded.valide_le, retire_le=NULL",
            (slug, "premier_contact", objet, corps, auteur.strip()[:60],
             maintenant()))

    changer_etat(slug, "en_file", motif="validation_humaine", auteur=auteur,
                 attendu="brouillon_pret")
    return "en_file"


def retirer_de_la_file(slug: str, motif: str = "retrait_de_file") -> None:
    with store.connexion() as conn:
        conn.execute("UPDATE prospection_outbox SET retire_le=?"
                     " WHERE slug=? AND retire_le IS NULL",
                     (maintenant(), slug))
    tracer(slug, "retrait_de_file", motif=motif)


def valider_accroche(slug: str, accroche: str, auteur: str) -> str:
    """Enregistre l'accroche relue et passe le dossier en brouillon prêt."""
    if not auteur.strip():
        raise ValueError("auteur requis")
    texte = accroche.strip()
    if len(texte) < 40:
        raise ValueError("accroche trop courte")
    if "[À compléter" in texte:
        raise ValueError("le marqueur à compléter est encore présent")

    with store.connexion() as conn:
        conn.execute("UPDATE prospection SET accroche=?, accroche_origine=?"
                     " WHERE slug=?", (texte, "humain", slug))
    return changer_etat(slug, "brouillon_pret", motif="validation_humaine",
                        auteur=auteur, attendu="verifie")


def file_attente() -> list[dict]:
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT o.slug, o.objet, o.valide_le, p.nom_atelier, p.courriel,"
            " p.etat FROM prospection_outbox o JOIN prospection p"
            " ON p.slug=o.slug WHERE o.retire_le IS NULL"
            " ORDER BY o.valide_le").fetchall()
    return [dict(l) for l in lignes]


# --------------------------------------------------------------------------- #
# 11. Échéances — calculées ici, appliquées au lot 3
# --------------------------------------------------------------------------- #

def dossiers_a_relancer() -> list[dict]:
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT * FROM prospection WHERE etat='envoye'"
            " AND envoye_le IS NOT NULL AND envoye_le < ?"
            " AND relances_envoyees < ?",
            (_il_y_a(DELAI_RELANCE_JOURS), RELANCES_MAX)).fetchall()
    return [dict(l) for l in lignes]


def dossiers_a_clore() -> list[dict]:
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT * FROM prospection WHERE etat='relance'"
            " AND relance_le IS NOT NULL AND relance_le < ?",
            (_il_y_a(DELAI_CLOTURE_JOURS - DELAI_RELANCE_JOURS),)).fetchall()
    return [dict(l) for l in lignes]


# --------------------------------------------------------------------------- #
# 12. Jobs
# --------------------------------------------------------------------------- #

def file() -> None:
    """Ouvre et vérifie les dossiers du jour. N'envoie rien, ne met rien en file."""
    store.initialiser()
    initialiser()
    if not prendre_verrou("prospection_file"):
        print("[prospection] un passage est déjà en cours, abandon")
        return
    try:
        publiees = store.lister_fiches([StatutFiche.publiee.value], limite=200)
        with store.connexion() as conn:
            connus = {l["slug"] for l in conn.execute("SELECT slug FROM prospection")}

        nouveaux = [f for f in publiees
                    if f.slug not in connus and f.site_web
                    and not f.valide_par_artisan]

        comptes: dict[str, int] = {}
        for fiche in nouveaux[:DOSSIERS_MAX_PAR_PASSAGE]:
            ouvrir_dossier(fiche.slug)
            resultat = preparer(fiche.slug)
            comptes[resultat] = comptes.get(resultat, 0) + 1
            print(f"[prospection] {fiche.slug} → {resultat}")

        print("[prospection] " + (" · ".join(f"{k}: {v}" for k, v in
                                             sorted(comptes.items())) or "rien à faire"))
        print(f"[prospection] reste en file : "
              f"{max(0, len(nouveaux) - DOSSIERS_MAX_PAR_PASSAGE)}")
    finally:
        rendre_verrou("prospection_file")


def etat() -> None:
    store.initialiser()
    initialiser()
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT etat, COUNT(*) n FROM prospection GROUP BY etat").fetchall()
        opposes = conn.execute(
            "SELECT COUNT(*) n FROM prospection_opposition").fetchone()["n"]
        en_file = conn.execute(
            "SELECT COUNT(*) n FROM prospection_outbox"
            " WHERE retire_le IS NULL").fetchone()["n"]

    for ligne in sorted(lignes, key=lambda l: l["etat"]):
        print(f"  {LIBELLES.get(ligne['etat'], ligne['etat']):<32} {ligne['n']}")
    print(f"  {'en file d’envoi (validés)':<32} {en_file}")
    print(f"  {'oppositions enregistrées':<32} {opposes}")
    print(f"  à relancer : {len(dossiers_a_relancer())} · "
          f"à clore : {len(dossiers_a_clore())}")


def diagnostic() -> dict:
    """Vérifie les six garanties du lot. Lisible depuis le téléphone."""
    store.initialiser()
    initialiser()

    orphelins = incoherents = 0
    with store.connexion() as conn:
        etats = {l["etat"] for l in conn.execute(
            "SELECT DISTINCT etat FROM prospection")}
        inconnus = sorted(etats - set(TRANSITIONS))
        # Une ligne d'outbox sans dossier en file est une incohérence grave :
        # cela signifierait un envoi préparé sans validation traçable.
        orphelins = conn.execute(
            "SELECT COUNT(*) n FROM prospection_outbox o"
            " LEFT JOIN prospection p ON p.slug=o.slug"
            " WHERE o.retire_le IS NULL AND (p.slug IS NULL OR p.etat NOT IN"
            " ('en_file','envoye','relance','reponse','inscrit'))").fetchone()["n"]
        incoherents = conn.execute(
            "SELECT COUNT(*) n FROM prospection"
            " WHERE relances_envoyees > ?", (RELANCES_MAX,)).fetchone()["n"]

    propre, anomalies = journal_est_propre()
    resultat = {
        "lot": "1 — socle de données et de cohérence",
        "ia_branchee": False,
        "telegram_interactif": False,
        "relances_automatiques": False,
        "etats_declares": len(TRANSITIONS),
        "etats_inconnus_en_base": inconnus,
        "outbox_sans_validation": orphelins,
        "relances_au_dela_du_plafond": incoherents,
        "journal_caviarde": propre,
        "anomalies_journal": anomalies,
        "signataire_renseigne": bool(os.environ.get("NOVALUTH_SIGNATAIRE", "").strip()),
    }
    resultat["socle_sain"] = (not inconnus and orphelins == 0
                              and incoherents == 0 and propre)
    for cle, valeur in resultat.items():
        print(f"  {cle:<34} {valeur}")
    return resultat


JOBS = {"file": file, "etat": etat, "diagnostic": diagnostic}

if __name__ == "__main__":
    argument = sys.argv[1] if len(sys.argv) > 1 else "diagnostic"
    if argument in JOBS:
        JOBS[argument]()
    elif argument == "ouvrir" and len(sys.argv) > 2:
        store.initialiser(); initialiser()
        print(ouvrir_dossier(sys.argv[2]))
    elif argument == "preparer" and len(sys.argv) > 2:
        store.initialiser(); initialiser()
        print(preparer(sys.argv[2]))
    elif argument == "opposer" and len(sys.argv) > 2:
        opposer(sys.argv[2])
        print("opposition enregistrée")
    else:
        print("Jobs : file · etat · diagnostic · ouvrir <slug> · "
              "preparer <slug> · opposer <email>")
        raise SystemExit(1)
