"""
NOVALUTH — Prospection assistée des ateliers
============================================

Ce module ferme la boucle laissée ouverte par le pipeline de découverte :

    fiche publiée  →  relecture de la page de l'atelier  →  brouillon rédigé
    par l'IA  →  contrôle de cohérence  →  arbitrage Telegram  →  envoi par
    vous  →  relance unique  →  clôture

Trois règles tenues de bout en bout
-----------------------------------
1. **Aucun envoi automatique.** L'IA rédige, vous envoyez. C'est la règle RGPD
   sur la prospection en Europe, et c'est aussi ce qui fait qu'un artisan
   répond : un message visiblement humain convertit sans comparaison.

2. **Aucune personnalisation inventée.** Le bloc personnalisé est construit
   uniquement à partir du texte réellement lu sur le site de l'atelier. Un
   contrôle de cohérence refuse le brouillon si le nom ou la ville annoncés ne
   se retrouvent pas dans la page. C'est ce contrôle qui évite d'écrire
   « votre atelier de Cestas » à un luthier installé à 900 km de là.

3. **Une seule relance, puis on s'arrête.** Silence après relance = clôture
   définitive, et l'adresse n'est plus jamais sollicitée.

Commandes :
    python -m pipeline.prospection brouillons      # prépare les brouillons du jour
    python -m pipeline.prospection brouillon <slug>  # un atelier précis
    python -m pipeline.prospection relances        # relances dues + clôtures
    python -m pipeline.prospection etat            # tableau de bord Telegram
    python -m pipeline.prospection bloquer <email> # opposition d'un artisan

À placer dans : novaluth/pipeline/prospection.py
"""

from __future__ import annotations

import os
import re
import sys
import textwrap
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common.passerelle_client import (PasserelleIndisponible, demander_ia,
                                      demander_page)
from web import store
from web.schemas import StatutFiche

from .telegram import envoyer_message

# --------------------------------------------------------------------------- #
# 1. Réglages
# --------------------------------------------------------------------------- #

BROUILLONS_MAX_PAR_PASSAGE = 3      # trois par jour : c'est de l'artisanat aussi
DELAI_RELANCE_JOURS = 8
DELAI_CLOTURE_JOURS = 21            # après relance, sans réponse → clôture
COHERENCE_MINIMALE = 2              # nombre d'indices à retrouver dans la page

URL_BASE = os.environ.get("NOVALUTH_URL", "https://novaluth.com").rstrip("/")
EXPEDITEUR = os.environ.get("NOVALUTH_EXPEDITEUR", "contact@novaluth.com")
SIGNATAIRE = os.environ.get("NOVALUTH_SIGNATAIRE", "").strip()
DOSSIER_COURRIELS = Path(__file__).resolve().parent.parent / "data" / "courriels"

ETATS = (
    "brouillon",     # rédigé, en attente de votre arbitrage
    "a_corriger",    # vous avez demandé une reprise
    "envoye",        # premier message parti
    "relance",       # relance partie
    "reponse",       # l'artisan a répondu
    "inscrit",       # l'artisan a validé sa fiche
    "refus",         # l'artisan a dit non
    "sans_reponse",  # clos après relance
    "bloque",        # opposition : ne plus jamais contacter
    "abandonne",     # vous avez écarté ce brouillon
)

ETATS_TERMINAUX = {"refus", "sans_reponse", "bloque", "inscrit", "abandonne"}


# --------------------------------------------------------------------------- #
# 2. Schéma
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospection (
    slug             TEXT PRIMARY KEY,
    nom_atelier      TEXT NOT NULL,
    courriel         TEXT,
    prenom_contact   TEXT,
    site_web         TEXT,
    etat             TEXT NOT NULL DEFAULT 'brouillon',
    objet            TEXT,
    brouillon        TEXT,
    bloc_personnalise TEXT,
    indices_verifies TEXT,
    cree_le          TEXT NOT NULL,
    envoye_le        TEXT,
    relance_le       TEXT,
    reponse_le       TEXT,
    clos_le          TEXT,
    motif            TEXT,
    tentatives_ia    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prospection_etat ON prospection(etat);

CREATE TABLE IF NOT EXISTS prospection_opposition (
    courriel   TEXT PRIMARY KEY,
    motif      TEXT,
    ajoute_le  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prospection_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    horodatage  TEXT NOT NULL,
    evenement   TEXT NOT NULL,
    detail      TEXT
);
"""


def initialiser() -> None:
    with store.connexion() as conn:
        conn.executescript(SCHEMA)


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _il_y_a(jours: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=jours)).isoformat(timespec="seconds")


def _tracer(slug: str, evenement: str, detail: str = "") -> None:
    with store.connexion() as conn:
        conn.execute(
            "INSERT INTO prospection_journal (slug, horodatage, evenement, detail)"
            " VALUES (?,?,?,?)", (slug, maintenant(), evenement, detail[:400]))


# --------------------------------------------------------------------------- #
# 3. Contrôle de cohérence — le garde-fou
# --------------------------------------------------------------------------- #

def _normaliser(texte: str) -> str:
    """Minuscules, sans accent, sans ponctuation. Pour comparer sans piège."""
    sans_accent = unicodedata.normalize("NFKD", texte or "")
    sans_accent = "".join(c for c in sans_accent if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9 ]+", " ", sans_accent.lower())


def verifier_coherence(fiche, texte_page: str) -> tuple[bool, list[str], str]:
    """Vérifie que la fiche décrit bien l'atelier dont on vient de lire la page.

    C'est le contrôle qui empêche d'écrire à un artisan en lui décrivant
    l'atelier d'un autre. Retourne (accepté, indices retrouvés, motif de refus).
    """
    page = _normaliser(texte_page)
    if len(page) < 400:
        return False, [], "page trop courte pour vérifier quoi que ce soit"

    indices: list[str] = []

    # Le nom de l'atelier doit figurer sur sa propre page. Sinon, on ne sait
    # pas de qui on parle.
    mots_nom = [m for m in _normaliser(fiche.nom).split() if len(m) > 3]
    nom_present = bool(mots_nom) and all(m in page for m in mots_nom[:3])
    if nom_present:
        indices.append(f"nom « {fiche.nom} »")
    else:
        return False, [], (f"le nom « {fiche.nom} » ne figure pas sur la page lue : "
                           f"la fiche et le site ne correspondent peut-être pas")

    # La ville est l'indice le plus discriminant, et celui qui provoque les
    # erreurs les plus humiliantes quand il est faux.
    if fiche.ville:
        if _normaliser(fiche.ville).strip() in page:
            indices.append(f"ville « {fiche.ville} »")
        else:
            return False, indices, (
                f"la ville « {fiche.ville} » n'apparaît pas sur la page : "
                f"vérifiez la fiche avant tout contact")

    for valeur, etiquette in (
        (fiche.annee_creation and str(fiche.annee_creation), "année de création"),
        (fiche.pays, "pays"),
    ):
        if valeur and _normaliser(str(valeur)).strip() in page:
            indices.append(etiquette)

    for marqueur in (fiche.innovation.marqueurs or [])[:4]:
        if _normaliser(marqueur).strip() and _normaliser(marqueur).strip() in page:
            indices.append(f"« {marqueur} »")

    for modele in (fiche.modeles or [])[:4]:
        cible = _normaliser(modele.nom).strip()
        if cible and len(cible) > 3 and cible in page:
            indices.append(f"modèle « {modele.nom} »")

    if len(indices) < COHERENCE_MINIMALE:
        return False, indices, (
            f"seulement {len(indices)} indice(s) retrouvé(s) sur la page : "
            f"personnalisation trop faible pour un premier contact")

    return True, indices, ""


# --------------------------------------------------------------------------- #
# 4. Rédaction du bloc personnalisé
# --------------------------------------------------------------------------- #

SCHEMA_PERSONNALISATION = {
    "name": "rediger_personnalisation",
    "description": "Rédige l'accroche personnalisée d'un premier courriel à un "
                   "artisan luthier, à partir du texte de son propre site.",
    "parameters": {
        "type": "object",
        "properties": {
            "utilisable": {
                "type": "boolean",
                "description": "false si la page ne permet pas d'écrire deux "
                               "phrases précises et vérifiables",
            },
            "prenom_contact": {
                "type": "string",
                "description": "Prénom de l'artisan SI la page le donne "
                               "explicitement. Sinon, chaîne vide.",
            },
            "accroche": {
                "type": "string",
                "description": "Deux à trois phrases en français, à la deuxième "
                               "personne du pluriel, citant des éléments "
                               "concrets présents dans la page : parcours, "
                               "spécialité, matériau, modèle, technique. Aucun "
                               "superlatif, aucune flatterie creuse.",
            },
            "elements_cites": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Chaque élément factuel repris dans l'accroche, "
                               "tel qu'il apparaît dans la page.",
            },
            "ville_detectee": {"type": "string"},
        },
        "required": ["utilisable", "accroche", "elements_cites"],
    },
}

SYSTEME_PERSONNALISATION = """Tu rédiges l'accroche d'un premier courriel adressé à
un luthier artisan, à partir du texte de SON PROPRE SITE.

Contexte : Novaluth est un annuaire qui met en relation musiciens et luthiers
indépendants. L'objectif du courriel est d'obtenir un échange, pas de vendre.

Règles absolues :
- N'écris QUE ce que la page dit. Aucune ville, aucune année, aucune technique,
  aucun matériau, aucun modèle que tu n'as pas lu noir sur blanc.
- Si la page ne permet pas deux phrases précises, réponds utilisable = false.
  Un courriel vague vaut moins que pas de courriel.
- prenom_contact : uniquement si la page nomme explicitement l'artisan. En cas
  de doute, laisse vide : un prénom erroné détruit le message.
- Vouvoiement, ton sobre et professionnel, phrases courtes.
- Parle de son travail, pas du tien. L'accroche ne présente pas Novaluth.
# conformite:debut-liste-proscrite
- Aucun superlatif, et jamais les mots garanti, certifié, meilleur, idéal,
  parfait, recommandé, exceptionnel, incontournable, unique.
# conformite:fin-liste-proscrite
- Pas de « j'ai découvert votre magnifique travail », pas de « je suis tombé sur
  votre site par hasard ». Sois factuel et direct.
"""


def _gabarit_courriel(prenom: str, accroche: str) -> tuple[str, str]:
    """Assemble l'objet et le corps. Le barème complet y figure : les deux
    gâchettes, pas seulement la première."""
    salutation = f"Bonjour {prenom}," if prenom else "Bonjour,"
    signature = SIGNATAIRE or "[votre prénom et nom — à renseigner dans NOVALUTH_SIGNATAIRE]"

    corps = f"""{salutation}

Je vous écris à la main, pas en nombre : votre atelier fait partie des premiers
de ma liste.

{accroche}

Je construis Novaluth, un annuaire qui met en relation musiciens et luthiers
indépendants. Volontairement : pas les grandes marques, pas les enseignes
installées. Ceux qui font l'instrument de demain.

Trois choses concrètes pour vous :

Des demandes déjà cadrées. Type d'instrument, budget, délai, contraintes
techniques, pays : le musicien remplit tout avant que vous receviez quoi que ce
soit. Fini les « bonjour combien pour une guitare ».

Aucun classement entre artisans. Ni note, ni étoile, ni niveau. L'ordre
d'affichage tourne équitablement chaque jour. Votre visibilité ne dépendra
jamais d'un score ni d'un volume d'avis.

Vous ne payez qu'après avoir été payé. Votre fiche, la réception des demandes,
les échanges avec le musicien, le devis : gratuits, sans abonnement,
définitivement. Deux moments seulement sont facturés — 29 € quand une commande
est signée et l'acompte encaissé, puis 2 % du prix, plafonné à 149 €, après que
le musicien a confirmé avoir reçu son instrument. Sur une guitare à 3 500 €,
cela fait 99 € au total. Si la commande ne se fait pas, si le client se
rétracte, si l'instrument n'est jamais livré : vous ne me devez rien.

Autrement dit, je ne gagne quelque chose que si vous avez réellement vendu et
livré. Je trouve ça plus sain que de vous vendre des contacts à l'aveugle.

Le site est en construction, et c'est précisément pour cela que je viens vous
voir maintenant : le fonctionnement peut encore intégrer l'avis d'un artisan qui
vit le métier. Rien ne sera publié sur votre atelier sans votre validation.

Vingt minutes par téléphone ou en visio vous conviendraient-elles ? Si le moment
est mal choisi, dites-le simplement, je n'insisterai pas.

Bien cordialement,
{signature}
Fondateur de Novaluth
{EXPEDITEUR} — {URL_BASE}

—
Ce message vous est adressé à titre professionnel, à partir des informations
publiques de votre site. Si vous ne souhaitez plus être contacté, répondez
« STOP » : votre adresse sera retirée définitivement et aucune fiche ne sera
publiée sur votre atelier.
"""
    return "Votre atelier, l'un des premiers que je voulais contacter", corps


def preparer_brouillon(slug: str, *, alerter: bool = True) -> str:
    """Relit la page de l'atelier, vérifie la cohérence, rédige le brouillon.

    Retourne un mot d'état lisible dans le journal.
    """
    fiche = store.lire_fiche(slug)
    if not fiche:
        return "fiche-introuvable"
    if not fiche.site_web:
        return "sans-site"

    with store.connexion() as conn:
        ligne = conn.execute(
            "SELECT etat FROM prospection WHERE slug=?", (slug,)).fetchone()
    if ligne and ligne["etat"] not in {"a_corriger"}:
        return f"deja-en-cours ({ligne['etat']})"

    try:
        page = demander_page(fiche.site_web)
    except PasserelleIndisponible as e:
        print(f"[prospection] passerelle : {e}")
        return "passerelle-indisponible"

    if not page.get("lue"):
        motif = str(page.get("motif", "motif non précisé"))
        store.journaliser("prospection_lecture_refusee", slug, motif[:200])
        return "lecture-refusée"

    texte = str(page.get("texte") or "")
    accepte, indices, motif = verifier_coherence(fiche, texte)
    if not accepte:
        _tracer(slug, "coherence_refusee", motif)
        if alerter:
            envoyer_message(
                f"⚠️ <b>{fiche.nom}</b> — brouillon non rédigé\n\n"
                f"{motif}\n\nIndices retrouvés : {', '.join(indices) or 'aucun'}\n"
                f"Site lu : {fiche.site_web}\n\n"
                f"<i>Corrigez la fiche dans /admin avant tout contact.</i>")
        return "incoherent"

    entete = (f"Adresse : {page.get('url_finale') or fiche.site_web}\n"
              f"Titre : {page.get('titre') or '(sans titre)'}\n"
              f"Nom connu de l'atelier : {fiche.nom}\n\n")
    try:
        reponse = demander_ia(SYSTEME_PERSONNALISATION, entete + texte[:9000],
                              outil=SCHEMA_PERSONNALISATION, temperature=0.3,
                              max_tokens=800)
    except PasserelleIndisponible as e:
        print(f"[prospection] passerelle : {e}")
        return "passerelle-indisponible"

    donnees = reponse.get("arguments") or {}
    if not donnees.get("utilisable") or not donnees.get("accroche"):
        _tracer(slug, "accroche_refusee", "page insuffisante selon l'IA")
        return "accroche-impossible"

    accroche = str(donnees["accroche"]).strip()
    cites = [str(x) for x in (donnees.get("elements_cites") or [])]

    # Second garde-fou : chaque élément cité par l'IA doit se retrouver dans la
    # page. C'est ce qui rattrape une invention passée à travers le prompt.
    page_normalisee = _normaliser(texte)
    inventes = [c for c in cites
                if _normaliser(c).strip() and _normaliser(c).strip() not in page_normalisee]
    if inventes:
        _tracer(slug, "elements_inventes", " · ".join(inventes)[:300])
        if alerter:
            envoyer_message(
                f"⚠️ <b>{fiche.nom}</b> — brouillon écarté\n\n"
                f"L'IA a cité des éléments absents de la page :\n"
                f"{', '.join(inventes[:5])}\n\n"
                f"<i>Rien n'a été enregistré. Relancez plus tard.</i>")
        return "elements-inventes"

    prenom = str(donnees.get("prenom_contact") or "").strip()
    # Un prénom de plus d'un mot ou avec un chiffre n'est pas un prénom.
    if not re.fullmatch(r"[A-ZÀ-Ý][a-zà-ÿ'\-]{1,20}", prenom or ""):
        prenom = ""

    objet, corps = _gabarit_courriel(prenom, accroche)
    courriel = _extraire_courriel(texte) or ""

    with store.connexion() as conn:
        conn.execute(
            "INSERT INTO prospection (slug, nom_atelier, courriel, prenom_contact,"
            " site_web, etat, objet, brouillon, bloc_personnalise,"
            " indices_verifies, cree_le, tentatives_ia)"
            " VALUES (?,?,?,?,?,'brouillon',?,?,?,?,?,1)"
            " ON CONFLICT(slug) DO UPDATE SET etat='brouillon', objet=excluded.objet,"
            " brouillon=excluded.brouillon, bloc_personnalise=excluded.bloc_personnalise,"
            " indices_verifies=excluded.indices_verifies, prenom_contact=excluded.prenom_contact,"
            " courriel=COALESCE(prospection.courriel, excluded.courriel),"
            " tentatives_ia=prospection.tentatives_ia+1",
            (slug, fiche.nom, courriel, prenom, fiche.site_web, objet, corps,
             accroche, " · ".join(indices), maintenant()))

    _tracer(slug, "brouillon_pret", " · ".join(indices)[:300])
    if alerter:
        envoyer_brouillon(slug)
    return "brouillon-pret"


_MOTIF_COURRIEL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]{2,}")


def _extraire_courriel(texte: str) -> str | None:
    """Récupère une adresse de contact visible sur la page, si elle y est."""
    for trouve in _MOTIF_COURRIEL.findall(texte):
        minuscule = trouve.lower()
        if any(x in minuscule for x in ("example.", "sentry", "wixpress",
                                        "@2x", "no-reply", "noreply")):
            continue
        return trouve
    return None


# --------------------------------------------------------------------------- #
# 5. Arbitrage Telegram
# --------------------------------------------------------------------------- #

ACTIONS_PROSPECTION = {
    "penv": ("envoye", "📨 Marqué envoyé"),
    "pcor": ("a_corriger", "✏️ À reprendre"),
    "paba": ("abandonne", "🗑 Abandonné"),
    "prep": ("reponse", "💬 Réponse reçue"),
    "pins": ("inscrit", "🎉 Inscrit"),
    "pref": ("refus", "🚫 Refus"),
    "pblo": ("bloque", "⛔️ Ne plus contacter"),
}


def envoyer_brouillon(slug: str) -> None:
    """Pousse le brouillon sur Telegram avec les boutons d'arbitrage."""
    import html as html_mod

    with store.connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM prospection WHERE slug=?", (slug,)).fetchone()
    if not ligne:
        return
    p = dict(ligne)
    e = html_mod.escape

    apercu = textwrap.shorten(p["bloc_personnalise"] or "", 400, placeholder="…")
    destinataire = p["courriel"] or "⚠️ adresse à trouver sur le site"
    prenom = p["prenom_contact"] or "⚠️ prénom inconnu — vérifiez avant envoi"

    texte = (
        f"✉️ <b>{e(p['nom_atelier'])}</b>\n"
        f"<i>brouillon prêt, à relire</i>\n\n"
        f"À : {e(destinataire)}\n"
        f"Prénom : {e(prenom)}\n"
        f"Objet : {e(p['objet'] or '')}\n\n"
        f"<b>Accroche personnalisée</b>\n{e(apercu)}\n\n"
        f"Indices vérifiés sur son site : {e(p['indices_verifies'] or '—')}\n"
        f"Site : {e(p['site_web'] or '—')}\n\n"
        f"Texte complet : {URL_BASE}/admin/prospection/{e(slug)}\n\n"
        f"<i>Relisez, personnalisez une ligne de plus si vous pouvez, puis "
        f"envoyez depuis votre messagerie.</i>"
    )
    clavier = [
        [{"text": "📨 Envoyé", "callback_data": f"penv:{slug}"},
         {"text": "✏️ À reprendre", "callback_data": f"pcor:{slug}"}],
        [{"text": "🗑 Abandonner", "callback_data": f"paba:{slug}"}],
    ]
    envoyer_message(texte, clavier)


def traiter_clic(code: str, slug: str) -> str:
    """Applique une action de prospection. Appelé par le bot Telegram."""
    if code not in ACTIONS_PROSPECTION:
        return ""
    etat, libelle = ACTIONS_PROSPECTION[code]

    with store.connexion() as conn:
        ligne = conn.execute(
            "SELECT nom_atelier, courriel FROM prospection WHERE slug=?",
            (slug,)).fetchone()
        if not ligne:
            return "Dossier de prospection introuvable"
        nom, courriel = ligne["nom_atelier"], ligne["courriel"]

        champs = "etat=?"
        valeurs: list = [etat]
        if etat == "envoye":
            champs += ", envoye_le=?"
            valeurs.append(maintenant())
        if etat in {"reponse", "inscrit"}:
            champs += ", reponse_le=?"
            valeurs.append(maintenant())
        if etat in ETATS_TERMINAUX:
            champs += ", clos_le=?"
            valeurs.append(maintenant())
        valeurs.append(slug)
        conn.execute(f"UPDATE prospection SET {champs} WHERE slug=?", valeurs)

        if etat == "bloque" and courriel:
            conn.execute(
                "INSERT OR REPLACE INTO prospection_opposition"
                " (courriel, motif, ajoute_le) VALUES (?,?,?)",
                (courriel.lower(), "opposition signalée depuis Telegram",
                 maintenant()))

    _tracer(slug, f"arbitrage_{etat}")
    return f"{nom} → {libelle}"


# --------------------------------------------------------------------------- #
# 6. Les jobs
# --------------------------------------------------------------------------- #

def _oppose(courriel: str | None) -> bool:
    if not courriel:
        return False
    with store.connexion() as conn:
        return conn.execute(
            "SELECT 1 FROM prospection_opposition WHERE courriel=?",
            (courriel.lower(),)).fetchone() is not None


def brouillons() -> None:
    """Prépare les brouillons du jour pour les fiches publiées jamais contactées."""
    store.initialiser()
    initialiser()

    publiees = store.lister_fiches([StatutFiche.publiee.value], limite=200)
    with store.connexion() as conn:
        deja = {l["slug"] for l in conn.execute("SELECT slug FROM prospection")}

    candidats = [f for f in publiees
                 if f.slug not in deja and f.site_web and not f.valide_par_artisan]

    if not candidats:
        envoyer_message("✉️ Prospection — aucun atelier nouveau à contacter "
                        "aujourd'hui.")
        return

    comptes: dict[str, int] = {}
    for fiche in candidats[:BROUILLONS_MAX_PAR_PASSAGE]:
        etat = preparer_brouillon(fiche.slug)
        comptes[etat] = comptes.get(etat, 0) + 1
        print(f"[prospection] {fiche.slug} → {etat}")

    detail = " · ".join(f"{k} : {v}" for k, v in sorted(comptes.items()))
    envoyer_message(f"✉️ Prospection — passage du jour\n{detail}\n\n"
                    f"Reste en file : {max(0, len(candidats) - BROUILLONS_MAX_PAR_PASSAGE)}")


def relances() -> None:
    """Relance unique à 8 jours, puis clôture à 21 jours. Jamais plus."""
    store.initialiser()
    initialiser()

    with store.connexion() as conn:
        a_relancer = [dict(l) for l in conn.execute(
            "SELECT * FROM prospection WHERE etat='envoye'"
            " AND envoye_le IS NOT NULL AND envoye_le < ?"
            " AND relance_le IS NULL", (_il_y_a(DELAI_RELANCE_JOURS),))]
        a_clore = [dict(l) for l in conn.execute(
            "SELECT * FROM prospection WHERE etat='relance'"
            " AND relance_le IS NOT NULL AND relance_le < ?",
            (_il_y_a(DELAI_CLOTURE_JOURS - DELAI_RELANCE_JOURS),))]

    for p in a_relancer:
        if _oppose(p["courriel"]):
            continue
        prenom = p["prenom_contact"] or ""
        salutation = f"Bonjour {prenom}," if prenom else "Bonjour,"
        texte = (f"{salutation}\n\n"
                 f"Je remonte simplement mon message au cas où il serait passé "
                 f"inaperçu.\n\nSi le sujet ne vous intéresse pas, aucun souci : "
                 f"je ne vous relancerai plus.\n\n"
                 f"Bien cordialement,\n{SIGNATAIRE or '[votre nom]'}\n"
                 f"{EXPEDITEUR}")
        _ecrire_courriel(p["courriel"] or "adresse-inconnue", "Relance", texte)
        with store.connexion() as conn:
            conn.execute("UPDATE prospection SET etat='relance', relance_le=?"
                         " WHERE slug=?", (maintenant(), p["slug"]))
        _tracer(p["slug"], "relance_preparee")
        envoyer_message(
            f"🔔 Relance à envoyer — <b>{p['nom_atelier']}</b>\n\n"
            f"À : {p['courriel'] or '⚠️ adresse inconnue'}\n\n{texte}",
            [[{"text": "📨 Envoyée", "callback_data": f"penv:{p['slug']}"},
              {"text": "🗑 Abandonner", "callback_data": f"paba:{p['slug']}"}]])

    for p in a_clore:
        with store.connexion() as conn:
            conn.execute("UPDATE prospection SET etat='sans_reponse', clos_le=?,"
                         " motif='silence après relance unique' WHERE slug=?",
                         (maintenant(), p["slug"]))
        _tracer(p["slug"], "cloture_sans_reponse")

    envoyer_message(f"🔔 Prospection — {len(a_relancer)} relance(s) préparée(s) · "
                    f"{len(a_clore)} dossier(s) clos définitivement")


def _ecrire_courriel(destinataire: str, sujet: str, corps: str) -> None:
    """Écrit le message dans data/courriels/ pour copie manuelle.

    Délibérément : aucun envoi automatisé. Vous copiez, vous relisez, vous
    envoyez depuis votre messagerie. C'est la seule manière d'être sûr qu'un
    humain a validé le message avant qu'il ne parte.
    """
    try:
        from web import courriel as _c  # type: ignore
        if hasattr(_c, "ecrire_brouillon"):
            _c.ecrire_brouillon(destinataire, sujet, corps)  # type: ignore[attr-defined]
            return
    except Exception:
        pass
    DOSSIER_COURRIELS.mkdir(parents=True, exist_ok=True)
    nom = f"{maintenant().replace(':', '-')}_prospection_{destinataire.replace('@', '_at_')}.txt"
    (DOSSIER_COURRIELS / nom).write_text(
        f"A: {destinataire}\nObjet: {sujet}\n\n{corps}\n", encoding="utf-8")


def etat() -> None:
    """Tableau de bord sur Telegram. Des compteurs, aucun score d'artisan."""
    store.initialiser()
    initialiser()
    with store.connexion() as conn:
        lignes = conn.execute(
            "SELECT etat, COUNT(*) n FROM prospection GROUP BY etat").fetchall()
        opposes = conn.execute(
            "SELECT COUNT(*) n FROM prospection_opposition").fetchone()["n"]

    compteurs = {l["etat"]: l["n"] for l in lignes}
    total = sum(compteurs.values())
    contactes = sum(compteurs.get(e, 0) for e in
                    ("envoye", "relance", "reponse", "inscrit", "refus",
                     "sans_reponse"))
    reponses = compteurs.get("reponse", 0) + compteurs.get("inscrit", 0) + \
        compteurs.get("refus", 0)
    taux = f"{100 * reponses / contactes:.0f} %" if contactes else "—"

    detail = "\n".join(f"· {k} : {v}" for k, v in sorted(compteurs.items()))
    envoyer_message(
        f"📮 <b>Prospection Novaluth</b>\n\n{detail or 'aucun dossier'}\n\n"
        f"Ateliers contactés : {contactes}\n"
        f"Taux de réponse : {taux}\n"
        f"Inscrits : {compteurs.get('inscrit', 0)}\n"
        f"Oppositions enregistrées : {opposes}\n"
        f"Total suivi : {total}")


def bloquer(courriel: str, motif: str = "demande de l'artisan") -> None:
    """Opposition : l'adresse ne sera plus jamais sollicitée."""
    initialiser()
    with store.connexion() as conn:
        conn.execute("INSERT OR REPLACE INTO prospection_opposition"
                     " (courriel, motif, ajoute_le) VALUES (?,?,?)",
                     (courriel.lower().strip(), motif, maintenant()))
        conn.execute("UPDATE prospection SET etat='bloque', clos_le=?, motif=?"
                     " WHERE lower(courriel)=?",
                     (maintenant(), motif, courriel.lower().strip()))
    envoyer_message(f"⛔️ {courriel} ajouté aux oppositions. Cette adresse ne "
                    f"sera plus jamais sollicitée.")


JOBS = {"brouillons": brouillons, "relances": relances, "etat": etat}

if __name__ == "__main__":
    argument = sys.argv[1] if len(sys.argv) > 1 else "etat"
    if argument == "brouillon":
        if len(sys.argv) < 3:
            print("Usage : python -m pipeline.prospection brouillon <slug>")
            raise SystemExit(1)
        store.initialiser()
        initialiser()
        print(f"[prospection] {sys.argv[2]} → {preparer_brouillon(sys.argv[2])}")
    elif argument == "bloquer":
        if len(sys.argv) < 3:
            print("Usage : python -m pipeline.prospection bloquer <email>")
            raise SystemExit(1)
        bloquer(sys.argv[2])
    elif argument in JOBS:
        JOBS[argument]()
    else:
        print(f"Jobs : {', '.join(JOBS)}, brouillon <slug>, bloquer <email>")
        raise SystemExit(1)
