"""Novaluth — rendez-vous en visioconference. Version JaaS.

Deux modes, selectionnes par le secret NOVALUTH_VISIO :

  « public »  -> meet.jit.si. Aucun compte a creer, mais le premier arrivant
                 doit se connecter (Google, Facebook ou GitHub) pour devenir
                 moderateur. Utile pour tester, penible pour un artisan.

  « jaas »    -> Jitsi as a Service de 8x8. Vous creez un compte gratuit,
                 votre serveur signe un jeton par participant, et personne
                 n'a plus rien a creer : on clique, on entre.
                 L'artisan recoit le role moderateur, le musicien celui de
                 participant.

Dans les deux modes : enregistrement, diffusion et transcription desactives.
Novaluth n'assiste pas a l'appel et n'en conserve aucun contenu — seulement
les metadonnees du rendez-vous.

Dependances pour le mode jaas :
    pyjwt>=2.8.0
    cryptography>=42.0.0

A placer dans : novaluth/web/visio.py
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import HTMLResponse

routeur = APIRouter(tags=["visio"])

# ---------------------------------------------------------------------------
# Reglages
# ---------------------------------------------------------------------------

MODE = os.environ.get("NOVALUTH_VISIO", "public").strip().lower()

# Mode public
DOMAINE_PUBLIC = os.environ.get("NOVALUTH_JITSI_DOMAINE", "meet.jit.si")

# Mode JaaS — les trois valeurs viennent de la console 8x8.
DOMAINE_JAAS = "8x8.vc"
JAAS_APP_ID = os.environ.get("JAAS_APP_ID", "").strip()
JAAS_API_KEY_ID = os.environ.get("JAAS_API_KEY_ID", "").strip()
JAAS_CLE_PRIVEE = os.environ.get("JAAS_CLE_PRIVEE", "").strip()

DUREE_JETON_HEURES = 3           # validite du jeton d'entree
DUREE_VALIDITE_JOURS = 30        # au-dela, le lien de salle n'ouvre plus
DELAI_RAPPEL_HEURES = 24         # rappel avant un rendez-vous programme
PURGE_METADONNEES_JOURS = 180    # minimisation RGPD

OBJETS = {
    "projet": "Rendez-vous projet, avant devis",
    "bois": "Validation des bois",
    "assemblage": "Validation du corps et du manche",
    "finition": "Validation de la couleur et de la finition",
    "final": "Presentation de l'instrument termine",
    "autre": "Echange libre",
}

RACINE = Path(__file__).resolve().parent.parent
CHEMIN_BASE = Path(os.environ.get("NOVALUTH_BASE", RACINE / "data" / "novaluth.db"))
URL_BASE = os.environ.get("NOVALUTH_URL", "http://localhost:8000").rstrip("/")
DOSSIER_COURRIELS = RACINE / "data" / "courriels"


def mode_jaas_pret() -> bool:
    """Vrai si les trois secrets JaaS sont presents."""
    return bool(JAAS_APP_ID and JAAS_API_KEY_ID and JAAS_CLE_PRIVEE)


def domaine() -> str:
    return DOMAINE_JAAS if (MODE == "jaas" and mode_jaas_pret()) else DOMAINE_PUBLIC


def script_externe() -> str:
    if MODE == "jaas" and mode_jaas_pret():
        return f"https://{DOMAINE_JAAS}/{JAAS_APP_ID}/external_api.js"
    return f"https://{DOMAINE_PUBLIC}/external_api.js"


# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------

@contextmanager
def connexion() -> Iterator[sqlite3.Connection]:
    CHEMIN_BASE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CHEMIN_BASE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS rendez_vous (
    id                 TEXT PRIMARY KEY,
    commande_id        TEXT,
    projet_id          TEXT,
    atelier_id         TEXT NOT NULL,
    atelier_courriel   TEXT NOT NULL,
    atelier_nom        TEXT,
    musicien_courriel  TEXT NOT NULL,
    musicien_nom       TEXT,
    objet              TEXT NOT NULL DEFAULT 'projet',
    salle              TEXT NOT NULL UNIQUE,
    jeton_atelier      TEXT NOT NULL UNIQUE,
    jeton_musicien     TEXT NOT NULL UNIQUE,
    debut_prevu        TEXT,
    cree_le            TEXT NOT NULL,
    expire_le          TEXT NOT NULL,
    annule_le          TEXT,
    rappel_envoye_le   TEXT,
    entree_atelier_le  TEXT,
    entree_musicien_le TEXT
);

CREATE INDEX IF NOT EXISTS idx_rdv_atelier  ON rendez_vous(atelier_id);
CREATE INDEX IF NOT EXISTS idx_rdv_commande ON rendez_vous(commande_id);
"""


def initialiser() -> None:
    with connexion() as conn:
        conn.executescript(SCHEMA)
        # Ajout tolerant des colonnes de nom, si la table vient de la v1.
        colonnes = {l["name"] for l in conn.execute("PRAGMA table_info(rendez_vous)")}
        for nom in ("atelier_nom", "musicien_nom"):
            if nom not in colonnes:
                conn.execute(f"ALTER TABLE rendez_vous ADD COLUMN {nom} TEXT")


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dans_jours(jours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=jours)).isoformat(timespec="seconds")


def _echu(horodatage: str | None) -> bool:
    if not horodatage:
        return False
    return datetime.fromisoformat(horodatage) < datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Jeton JaaS
# ---------------------------------------------------------------------------

class VisioIndisponible(RuntimeError):
    """Le mode jaas est demande mais mal configure."""


def fabriquer_jeton(*, salle: str, nom: str, courriel: str,
                    moderateur: bool) -> str:
    """Signe un JWT RS256 conforme a la specification JaaS.

    Structure imposee par 8x8 :
      en-tete : alg=RS256, kid=<API Key ID>, typ=JWT
      corps   : aud='jitsi', iss='chat', sub=<AppID>, room=<nom de salle>,
                exp, nbf, context.user{...}, context.features{...}
    """
    if not mode_jaas_pret():
        raise VisioIndisponible(
            "JAAS_APP_ID, JAAS_API_KEY_ID et JAAS_CLE_PRIVEE doivent etre renseignes."
        )

    try:
        import jwt  # PyJWT
    except ImportError as erreur:  # pragma: no cover
        raise VisioIndisponible(
            "Le paquet pyjwt[crypto] est requis. Ajoutez-le a requirements.txt."
        ) from erreur

    instant = datetime.now(timezone.utc)
    corps = {
        "aud": "jitsi",
        "iss": "chat",
        "sub": JAAS_APP_ID,
        "room": salle,
        "nbf": int((instant - timedelta(minutes=5)).timestamp()),
        "exp": int((instant + timedelta(hours=DUREE_JETON_HEURES)).timestamp()),
        "context": {
            "user": {
                "id": uuid.uuid4().hex,
                "name": nom,
                "email": courriel,
                "moderator": "true" if moderateur else "false",
                "hidden-from-recorder": "false",
            },
            # Tout ce qui pourrait capter le contenu est refuse, y compris
            # pour le moderateur. Aucun enregistrement n'est possible.
            "features": {
                "recording": False,
                "livestreaming": False,
                "transcription": False,
                "sip-inbound-call": False,
                "sip-outbound-call": False,
                "inbound-call": False,
                "outbound-call": False,
                "file-upload": False,
            },
            "room": {"regex": False},
        },
    }

    cle = JAAS_CLE_PRIVEE.replace("\\n", "\n")
    return jwt.encode(
        corps, cle, algorithm="RS256",
        headers={"kid": JAAS_API_KEY_ID, "typ": "JWT"},
    )


def nom_salle_complet(salle: str) -> str:
    """En JaaS, le nom de salle est prefixe par l'AppID."""
    if MODE == "jaas" and mode_jaas_pret():
        return f"{JAAS_APP_ID}/{salle}"
    return salle


# ---------------------------------------------------------------------------
# Courriel
# ---------------------------------------------------------------------------

def _envoyer(destinataire: str, sujet: str, corps: str) -> None:
    try:
        from web import courriel as _c  # type: ignore
        for nom in ("envoyer", "expedier", "envoyer_message"):
            if hasattr(_c, nom):
                getattr(_c, nom)(destinataire, sujet, corps)
                return
    except Exception:
        pass
    DOSSIER_COURRIELS.mkdir(parents=True, exist_ok=True)
    horodatage = maintenant().replace(":", "-")
    fichier = DOSSIER_COURRIELS / f"{horodatage}_visio_{destinataire.replace('@', '_at_')}.txt"
    fichier.write_text(f"A: {destinataire}\nObjet: {sujet}\n\n{corps}\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Creation et lecture
# ---------------------------------------------------------------------------

def creer_rendez_vous(*, atelier_id: str, atelier_courriel: str,
                      musicien_courriel: str, objet: str = "projet",
                      atelier_nom: str | None = None,
                      musicien_nom: str | None = None,
                      commande_id: str | None = None,
                      projet_id: str | None = None,
                      debut_prevu: str | None = None) -> dict[str, Any]:
    if objet not in OBJETS:
        objet = "autre"

    # Nom de salle non devinable, sans caractere a echapper.
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    salle = "novaluth" + "".join(secrets.choice(alphabet) for _ in range(28))

    enregistrement = {
        "id": uuid.uuid4().hex,
        "commande_id": commande_id,
        "projet_id": projet_id,
        "atelier_id": atelier_id.strip(),
        "atelier_courriel": atelier_courriel.strip().lower(),
        "atelier_nom": (atelier_nom or "Atelier").strip()[:60],
        "musicien_courriel": musicien_courriel.strip().lower(),
        "musicien_nom": (musicien_nom or "Musicien").strip()[:60],
        "objet": objet,
        "salle": salle,
        "jeton_atelier": secrets.token_urlsafe(24),
        "jeton_musicien": secrets.token_urlsafe(24),
        "debut_prevu": debut_prevu,
        "cree_le": maintenant(),
        "expire_le": _dans_jours(DUREE_VALIDITE_JOURS),
    }

    with connexion() as conn:
        conn.execute(
            "INSERT INTO rendez_vous (id, commande_id, projet_id, atelier_id,"
            " atelier_courriel, atelier_nom, musicien_courriel, musicien_nom,"
            " objet, salle, jeton_atelier, jeton_musicien, debut_prevu,"
            " cree_le, expire_le)"
            " VALUES (:id,:commande_id,:projet_id,:atelier_id,:atelier_courriel,"
            ":atelier_nom,:musicien_courriel,:musicien_nom,:objet,:salle,"
            ":jeton_atelier,:jeton_musicien,:debut_prevu,:cree_le,:expire_le)",
            enregistrement,
        )
    return enregistrement


def lire_par_jeton(jeton: str) -> tuple[dict[str, Any] | None, str]:
    with connexion() as conn:
        ligne = conn.execute(
            "SELECT * FROM rendez_vous WHERE jeton_atelier=?", (jeton,)
        ).fetchone()
        if ligne is not None:
            return dict(ligne), "atelier"
        ligne = conn.execute(
            "SELECT * FROM rendez_vous WHERE jeton_musicien=?", (jeton,)
        ).fetchone()
        if ligne is not None:
            return dict(ligne), "musicien"
    return None, ""


def rendez_vous_atelier(atelier_id: str) -> list[dict[str, Any]]:
    with connexion() as conn:
        lignes = conn.execute(
            "SELECT * FROM rendez_vous WHERE atelier_id=? ORDER BY cree_le DESC LIMIT 50",
            (atelier_id,),
        ).fetchall()
    return [dict(l) for l in lignes]


def annuler(rdv_id: str) -> None:
    with connexion() as conn:
        conn.execute(
            "UPDATE rendez_vous SET annule_le=? WHERE id=? AND annule_le IS NULL",
            (maintenant(), rdv_id),
        )


def _marquer_entree(rdv_id: str, role: str) -> None:
    champ = "entree_atelier_le" if role == "atelier" else "entree_musicien_le"
    with connexion() as conn:
        conn.execute(
            f"UPDATE rendez_vous SET {champ}=COALESCE({champ}, ?) WHERE id=?",
            (maintenant(), rdv_id),
        )


def purger_metadonnees(jours: int = PURGE_METADONNEES_JOURS) -> int:
    limite = (datetime.now(timezone.utc) - timedelta(days=jours)).isoformat(timespec="seconds")
    with connexion() as conn:
        return conn.execute("DELETE FROM rendez_vous WHERE cree_le < ?", (limite,)).rowcount


def executer_taches() -> dict[str, int]:
    bilan = {"rappels": 0, "purges": 0}
    seuil = (datetime.now(timezone.utc) + timedelta(hours=DELAI_RAPPEL_HEURES)) \
        .isoformat(timespec="seconds")

    with connexion() as conn:
        lignes = conn.execute(
            "SELECT * FROM rendez_vous WHERE annule_le IS NULL"
            " AND debut_prevu IS NOT NULL AND debut_prevu <= ?"
            " AND debut_prevu >= ? AND rappel_envoye_le IS NULL",
            (seuil, maintenant()),
        ).fetchall()
        rdvs = [dict(l) for l in lignes]
        for rdv in rdvs:
            conn.execute(
                "UPDATE rendez_vous SET rappel_envoye_le=? WHERE id=?",
                (maintenant(), rdv["id"]),
            )

    for rdv in rdvs:
        for role, champ in (("atelier", "jeton_atelier"), ("musicien", "jeton_musicien")):
            destinataire = rdv["atelier_courriel"] if role == "atelier" \
                else rdv["musicien_courriel"]
            _envoyer(
                destinataire,
                "Rappel — votre rendez-vous en visioconference",
                f"""Bonjour,

Votre rendez-vous « {OBJETS.get(rdv['objet'], rdv['objet'])} » est prevu le
{rdv['debut_prevu']}.

Votre lien personnel :
{URL_BASE}/visio/{rdv[champ]}

Aucune installation, aucun compte a creer. Le rendez-vous est gratuit et
n'est pas enregistre.

Novaluth""",
            )
        bilan["rappels"] += 1

    bilan["purges"] = purger_metadonnees()
    return bilan


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------

def _page(titre: str, corps: str, tete: str = "") -> HTMLResponse:
    html = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{titre} — Novaluth</title>{tete}
<style>
 body{{margin:0;background:#050814;color:#F8FAFC;
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}}
 main{{max-width:34rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}}
 h1{{font-size:1.3rem;letter-spacing:.02em;margin:0 0 1rem}}
 .carte{{background:#0B1220;border:1px solid #1E293B;border-radius:14px;
         padding:1.15rem;margin:1rem 0}}
 dl{{margin:0}} dt{{color:#94A3B8;font-size:.8rem;margin-top:.7rem}}
 dd{{margin:.15rem 0 0;font-weight:600}}
 .note{{color:#94A3B8;font-size:.85rem}}
 .avert{{border-left:3px solid #FFD166;padding-left:.9rem;color:#CBD5E1;
         font-size:.88rem;margin:0}}
 button,.bouton{{display:block;width:100%;box-sizing:border-box;margin:.6rem 0;
   padding:.95rem 1rem;border-radius:11px;border:0;font-size:1rem;font-weight:600;
   text-align:center;text-decoration:none;cursor:pointer}}
 .oui{{background:#FFD166;color:#050814}}
 .non{{background:transparent;color:#94A3B8;border:1px solid #334155}}
 input,select{{width:100%;box-sizing:border-box;padding:.8rem;
   margin:.35rem 0 .9rem;border-radius:10px;border:1px solid #334155;
   background:#0B1220;color:#F8FAFC;font-size:1rem}}
 label{{font-size:.85rem;color:#94A3B8}}
 #salle{{width:100%;height:70vh;min-height:22rem;border:0;border-radius:14px;
         overflow:hidden;background:#000}}
</style></head><body><main>{corps}</main></body></html>"""
    return HTMLResponse(html)


# ---------------------------------------------------------------------------
# Cote atelier
# ---------------------------------------------------------------------------

@routeur.get("/atelier/visio", response_class=HTMLResponse)
def formulaire_visio(atelier: str = "", courriel: str = "",
                     musicien: str = "", commande: str = "") -> HTMLResponse:
    options = "".join(
        f'<option value="{cle}">{libelle}</option>' for cle, libelle in OBJETS.items()
    )
    if MODE == "jaas" and mode_jaas_pret():
        avis = ("Ni vous ni le musicien n'avez de compte a creer : le lien "
                "s'ouvre directement.")
    elif MODE == "jaas":
        avis = ("⚠️ Mode JaaS demande, mais les secrets sont incomplets. "
                "Le service public est utilise en attendant.")
    else:
        avis = ("Mode public : le premier arrive devra se connecter (Google, "
                "Facebook ou GitHub) pour ouvrir la salle.")

    corps = f"""
<h1>Proposer un rendez-vous en visio</h1>
<div class="carte">
  <p class="note">Gratuit pour vous comme pour le musicien, sans limite de duree.
  Le rendez-vous <strong>n'est pas enregistre</strong> : Novaluth n'y assiste pas
  et n'en conserve aucun contenu.</p>
  <p class="note">{avis}</p>
</div>
<form method="post" action="/atelier/visio">
  <label>Identifiant de votre atelier</label>
  <input name="atelier_id" value="{atelier}" required>
  <label>Nom affiche pendant l'appel</label>
  <input name="atelier_nom" placeholder="Atelier Dupont">
  <label>Votre adresse de contact</label>
  <input name="atelier_courriel" type="email" value="{courriel}" required>
  <label>Adresse du musicien</label>
  <input name="musicien_courriel" type="email" value="{musicien}" required>
  <label>Prenom du musicien, affiche pendant l'appel</label>
  <input name="musicien_nom" placeholder="Musicien">
  <label>Objet du rendez-vous</label>
  <select name="objet">{options}</select>
  <label>Date et heure proposees (facultatif)</label>
  <input name="debut_prevu" type="datetime-local">
  <label>Reference de commande, si elle existe (facultatif)</label>
  <input name="commande_id" value="{commande}">
  <button class="oui" type="submit">Creer le rendez-vous</button>
</form>
<p class="note">Deux liens personnels sont crees, valables
{DUREE_VALIDITE_JOURS} jours.</p>"""
    return _page("Proposer un rendez-vous", corps)


@routeur.post("/atelier/visio")
def creer_visio(
    atelier_id: str = Form(...),
    atelier_courriel: str = Form(...),
    musicien_courriel: str = Form(...),
    atelier_nom: str = Form(""),
    musicien_nom: str = Form(""),
    objet: str = Form("projet"),
    debut_prevu: str = Form(""),
    commande_id: str = Form(""),
) -> HTMLResponse:
    rdv = creer_rendez_vous(
        atelier_id=atelier_id,
        atelier_courriel=atelier_courriel,
        musicien_courriel=musicien_courriel,
        atelier_nom=atelier_nom or None,
        musicien_nom=musicien_nom or None,
        objet=objet,
        commande_id=commande_id.strip() or None,
        debut_prevu=debut_prevu.strip() or None,
    )

    libelle = OBJETS.get(rdv["objet"], rdv["objet"])
    quand = rdv["debut_prevu"] or "a convenir entre vous"
    sans_compte = "Aucun compte a creer, aucune installation." \
        if (MODE == "jaas" and mode_jaas_pret()) else "Aucune installation necessaire."

    _envoyer(
        rdv["musicien_courriel"],
        "Un atelier vous propose un rendez-vous en visio",
        f"""Bonjour,

L'atelier avec lequel vous echangez sur Novaluth vous propose un rendez-vous
en visioconference.

Objet : {libelle}
Date  : {quand}

Votre lien personnel, a ouvrir au moment du rendez-vous :
{URL_BASE}/visio/{rdv['jeton_musicien']}

Ce rendez-vous est gratuit. {sans_compte}

Il n'est pas enregistre. Novaluth n'y assiste pas, ne l'enregistre pas et n'en
conserve aucun contenu : seuls la date, l'objet et les participants sont
conserves pour organiser la rencontre.

Vous pouvez decliner sans aucune consequence : ce rendez-vous ne conditionne ni
un devis, ni une commande.

Novaluth""",
    )
    _envoyer(
        rdv["atelier_courriel"],
        "Votre rendez-vous en visio est cree",
        f"""Le rendez-vous « {libelle} » est cree.

Date : {quand}

Votre lien personnel :
{URL_BASE}/visio/{rdv['jeton_atelier']}

Conseil : ayez sous la main vos echantillons de bois, vos nuanciers de finition
et un instrument termine. C'est ce qui rend ce rendez-vous decisif.

Rappel : n'enregistrez pas l'appel sans l'accord explicite du musicien.

Novaluth""",
    )

    corps = f"""
<h1>Rendez-vous cree</h1>
<div class="carte">
  <dl>
    <dt>Objet</dt><dd>{libelle}</dd>
    <dt>Date</dt><dd>{quand}</dd>
    <dt>Validite des liens</dt><dd>{DUREE_VALIDITE_JOURS} jours</dd>
  </dl>
</div>
<p class="note">Les deux liens ont ete envoyes par courriel.</p>
<a class="bouton oui" href="/visio/{rdv['jeton_atelier']}">Ouvrir la salle</a>
<a class="bouton non" href="/atelier/{atelier_id}/visio">Voir mes rendez-vous</a>"""
    return _page("Rendez-vous cree", corps)


# ---------------------------------------------------------------------------
# La salle
# ---------------------------------------------------------------------------

@routeur.get("/visio/{jeton}", response_class=HTMLResponse)
def salle(jeton: str) -> HTMLResponse:
    rdv, role = lire_par_jeton(jeton)
    if rdv is None:
        raise HTTPException(status_code=404, detail="Rendez-vous introuvable")
    if rdv["annule_le"]:
        return _page("Rendez-vous annule",
                     '<h1>Rendez-vous annule</h1><div class="carte">'
                     "<p>Ce rendez-vous a ete annule.</p></div>")
    if _echu(rdv["expire_le"]):
        return _page("Lien expire",
                     '<h1>Lien expire</h1><div class="carte">'
                     "<p>Ce lien n'est plus valable. Demandez un nouveau "
                     "rendez-vous a votre interlocuteur.</p></div>")

    _marquer_entree(rdv["id"], role)

    libelle = OBJETS.get(rdv["objet"], rdv["objet"])
    est_atelier = role == "atelier"
    nom = (rdv["atelier_nom"] if est_atelier else rdv["musicien_nom"]) or (
        "Atelier" if est_atelier else "Musicien")
    courriel = rdv["atelier_courriel"] if est_atelier else rdv["musicien_courriel"]

    salle_js = quote(nom_salle_complet(rdv["salle"]), safe="/")
    jeton_js = ""

    if MODE == "jaas":
        try:
            # L'artisan est moderateur : il ouvre la salle sans attendre.
            jeton_js = fabriquer_jeton(
                salle=rdv["salle"], nom=nom, courriel=courriel,
                moderateur=est_atelier,
            )
        except VisioIndisponible as erreur:
            return _page(
                "Visio indisponible",
                f'<h1>Visio indisponible</h1><div class="carte"><p>{erreur}</p>'
                '<p class="note">Verifiez les secrets JAAS_APP_ID, '
                "JAAS_API_KEY_ID et JAAS_CLE_PRIVEE dans Replit.</p></div>",
            )

    ligne_jeton = f'    jwt: "{jeton_js}",\n' if jeton_js else ""
    tete = f'<script src="{script_externe()}"></script>'

    corps = f"""
<h1>{libelle}</h1>
<div id="salle"></div>
<div class="carte">
  <p class="avert"><strong>Cet appel n'est pas enregistre par Novaluth.</strong>
  Nous n'y assistons pas, ne l'enregistrons pas, ne le transcrivons pas et n'en
  conservons aucun contenu. Si votre interlocuteur souhaite enregistrer, il doit
  vous le demander et obtenir votre accord explicite au prealable.</p>
</div>
<div class="carte">
  <p class="note">Ce rendez-vous ne cree aucun engagement. Seul un devis ecrit et
  signe engage les parties. Novaluth n'est pas partie au contrat de
  fabrication.</p>
</div>
<a class="bouton non" href="/visio/{jeton}/externe">La camera ne fonctionne pas ?</a>
<script>
(function () {{
  var options = {{
    roomName: "{salle_js}",
{ligne_jeton}    parentNode: document.getElementById("salle"),
    userInfo: {{ displayName: {nom!r}, email: {courriel!r} }},
    configOverwrite: {{
      prejoinPageEnabled: true,
      disableDeepLinking: true,
      localRecording: {{ enabled: false }},
      fileRecordingsEnabled: false,
      liveStreamingEnabled: false,
      transcribingEnabled: false,
      disableThirdPartyRequests: true,
      toolbarButtons: [
        "microphone", "camera", "desktop", "fullscreen", "hangup",
        "chat", "tileview", "select-background", "toggle-camera", "settings"
      ]
    }},
    interfaceConfigOverwrite: {{
      SHOW_JITSI_WATERMARK: false,
      SHOW_BRAND_WATERMARK: false,
      DEFAULT_BACKGROUND: "#050814"
    }}
  }};
  try {{
    var api = new JitsiMeetExternalAPI("{domaine()}", options);
    api.addEventListener("readyToClose", function () {{ window.location.href = "/"; }});
  }} catch (e) {{
    document.getElementById("salle").innerHTML =
      '<div style="padding:1.5rem;color:#CBD5E1">' +
      "La salle n'a pas pu s'ouvrir ici. " +
      '<a style="color:#FFD166" href="/visio/{jeton}/externe">' +
      "Ouvrir dans le navigateur</a>.</div>";
  }}
}})();
</script>"""
    return _page(libelle, corps, tete)


@routeur.get("/visio/{jeton}/externe", response_class=HTMLResponse)
def salle_externe(jeton: str) -> HTMLResponse:
    """Repli iPhone : sortir de la PWA vers Safari."""
    rdv, role = lire_par_jeton(jeton)
    if rdv is None:
        raise HTTPException(status_code=404, detail="Rendez-vous introuvable")

    if MODE == "jaas" and mode_jaas_pret():
        est_atelier = role == "atelier"
        nom = (rdv["atelier_nom"] if est_atelier else rdv["musicien_nom"]) or "Invite"
        courriel = rdv["atelier_courriel"] if est_atelier else rdv["musicien_courriel"]
        jeton_jaas = fabriquer_jeton(salle=rdv["salle"], nom=nom,
                                     courriel=courriel, moderateur=est_atelier)
        lien = (f"https://{DOMAINE_JAAS}/{JAAS_APP_ID}/"
                f"{quote(rdv['salle'])}?jwt={jeton_jaas}")
    else:
        lien = f"https://{DOMAINE_PUBLIC}/{quote(rdv['salle'])}"

    corps = f"""
<h1>Ouvrir dans le navigateur</h1>
<div class="carte">
  <p>Si la camera ou le micro ne fonctionnent pas depuis l'application installee
  sur votre ecran d'accueil, ouvrez la salle directement dans votre
  navigateur.</p>
</div>
<a class="bouton oui" href="{lien}" target="_blank" rel="noopener">
  Ouvrir la salle dans le navigateur</a>
<a class="bouton non" href="/visio/{jeton}">Revenir</a>
<p class="note">Cet appel n'est pas enregistre par Novaluth.</p>"""
    return _page("Ouvrir dans le navigateur", corps)


# ---------------------------------------------------------------------------
# Tableau de bord et diagnostic
# ---------------------------------------------------------------------------

@routeur.get("/atelier/{atelier_id}/visio", response_class=HTMLResponse)
def tableau_visio(atelier_id: str) -> HTMLResponse:
    lignes = rendez_vous_atelier(atelier_id)
    if not lignes:
        contenu = '<div class="carte"><p>Aucun rendez-vous.</p></div>'
    else:
        contenu = ""
        for rdv in lignes:
            etat = "annule" if rdv["annule_le"] else (
                "expire" if _echu(rdv["expire_le"]) else "actif")
            contenu += f"""<div class="carte">
  <dl>
    <dt>Objet</dt><dd>{OBJETS.get(rdv['objet'], rdv['objet'])}</dd>
    <dt>Musicien</dt><dd>{rdv['musicien_courriel']}</dd>
    <dt>Date</dt><dd>{rdv['debut_prevu'] or 'a convenir'}</dd>
    <dt>Etat</dt><dd>{etat}</dd>
  </dl>
  <a class="bouton non" href="/visio/{rdv['jeton_atelier']}">Ouvrir la salle</a>
</div>"""

    corps = f"""
<h1>Vos rendez-vous</h1>
{contenu}
<a class="bouton oui" href="/atelier/visio?atelier={atelier_id}">
  Proposer un rendez-vous</a>
<p class="note">Gratuits, sans limite de duree, jamais enregistres par
Novaluth.</p>"""
    return _page("Vos rendez-vous", corps)


@routeur.post("/atelier/visio/{rdv_id}/annuler")
def annuler_visio(rdv_id: str) -> HTMLResponse:
    annuler(rdv_id)
    return _page("Annule",
                 '<h1>Rendez-vous annule</h1><div class="carte">'
                 "<p>Les deux liens sont desormais inactifs.</p></div>")


@routeur.get("/admin/visio/diagnostic")
def diagnostic() -> dict:
    """Verifie la configuration sans rien exposer de secret."""
    resultat = {
        "mode": MODE,
        "domaine": domaine(),
        "jaas_app_id_present": bool(JAAS_APP_ID),
        "jaas_api_key_id_present": bool(JAAS_API_KEY_ID),
        "jaas_cle_privee_presente": bool(JAAS_CLE_PRIVEE),
        "jaas_pret": mode_jaas_pret(),
        "pyjwt_disponible": False,
        "signature_test": "non testee",
    }
    try:
        import jwt  # noqa: F401
        resultat["pyjwt_disponible"] = True
    except ImportError:
        resultat["signature_test"] = "pyjwt manquant"
        return resultat

    if mode_jaas_pret():
        try:
            valeur = fabriquer_jeton(salle="novaluthtest", nom="Test",
                                     courriel="test@example.com", moderateur=True)
            resultat["signature_test"] = f"ok, {len(valeur)} caracteres"
        except Exception as erreur:  # pragma: no cover
            resultat["signature_test"] = f"echec : {erreur}"
    return resultat


if __name__ == "__main__":
    initialiser()
    print("Table rendez_vous prete.")
    print("Mode      :", MODE)
    print("Domaine   :", domaine())
    print("JaaS pret :", mode_jaas_pret())
    if MODE == "jaas" and mode_jaas_pret():
        try:
            valeur = fabriquer_jeton(salle="novaluthtest", nom="Test",
                                     courriel="test@example.com", moderateur=True)
            print("Signature : ok,", len(valeur), "caracteres")
        except Exception as erreur:
            print("Signature : echec —", erreur)
