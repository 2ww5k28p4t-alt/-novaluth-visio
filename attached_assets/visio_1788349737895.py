"""Novaluth — rendez-vous en visioconference.

Deux usages, tous deux gratuits pour les deux parties :

  1. « Rendez-vous projet »  : avant le devis, l'artisan et le musicien se
     parlent. Personne n'a encore paye quoi que ce soit.
  2. « Point d'avancement »  : pendant la fabrication, l'artisan montre les
     bois, le corps assemble, la couleur avant finition, et fait entendre
     l'instrument. C'est la version vivante des points de validation prevus
     a l'article 6 du modele de devis.

Choix techniques :

  - Jitsi Meet en iframe. Aucun compte, aucune carte bancaire, aucune limite
    de duree. Le nom de salle est un secret long, non devinable.
  - Aucun enregistrement. Novaluth n'assiste pas a l'appel, ne l'enregistre
    pas, ne le transcrit pas et n'en conserve aucun contenu. Seules les
    metadonnees du rendez-vous sont stockees : date, participants, objet.
  - Le module fonctionne meme sans le module commandes : un rendez-vous peut
    exister avant toute commande.

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

# Serveur Jitsi. « meet.jit.si » est le service public gratuit. Si vous
# heberger un jour votre propre instance, changez seulement ces deux valeurs.
JITSI_DOMAINE = os.environ.get("NOVALUTH_JITSI_DOMAINE", "meet.jit.si")
JITSI_SCRIPT = f"https://{JITSI_DOMAINE}/external_api.js"

PREFIXE_SALLE = "novaluth"
DUREE_VALIDITE_JOURS = 30        # au-dela, le lien de salle n'ouvre plus
DELAI_RAPPEL_HEURES = 24         # rappel avant un rendez-vous programme

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
    id                TEXT PRIMARY KEY,
    commande_id       TEXT,
    projet_id         TEXT,
    atelier_id        TEXT NOT NULL,
    atelier_courriel  TEXT NOT NULL,
    musicien_courriel TEXT NOT NULL,
    objet             TEXT NOT NULL DEFAULT 'projet',
    salle             TEXT NOT NULL UNIQUE,
    jeton_atelier     TEXT NOT NULL UNIQUE,
    jeton_musicien    TEXT NOT NULL UNIQUE,
    debut_prevu       TEXT,
    cree_le           TEXT NOT NULL,
    expire_le         TEXT NOT NULL,
    annule_le         TEXT,
    rappel_envoye_le  TEXT,
    entree_atelier_le TEXT,
    entree_musicien_le TEXT,
    note_atelier      TEXT
);

CREATE INDEX IF NOT EXISTS idx_rdv_atelier  ON rendez_vous(atelier_id);
CREATE INDEX IF NOT EXISTS idx_rdv_commande ON rendez_vous(commande_id);
"""


def initialiser() -> None:
    with connexion() as conn:
        conn.executescript(SCHEMA)


def maintenant() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dans_jours(jours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=jours)).isoformat(timespec="seconds")


def _echu(horodatage: str | None) -> bool:
    if not horodatage:
        return False
    return datetime.fromisoformat(horodatage) < datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Courriel — reutilise web/courriel.py s'il existe
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
                      commande_id: str | None = None,
                      projet_id: str | None = None,
                      debut_prevu: str | None = None) -> dict[str, Any]:
    """Cree la salle et les deux liens personnels. Rien n'est facture."""
    if objet not in OBJETS:
        objet = "autre"

    rdv_id = uuid.uuid4().hex
    # Nom de salle non devinable : 32 caracteres aleatoires.
    salle = f"{PREFIXE_SALLE}-{secrets.token_urlsafe(24).replace('_', '').replace('-', '')}"

    enregistrement = {
        "id": rdv_id,
        "commande_id": commande_id,
        "projet_id": projet_id,
        "atelier_id": atelier_id.strip(),
        "atelier_courriel": atelier_courriel.strip().lower(),
        "musicien_courriel": musicien_courriel.strip().lower(),
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
            " atelier_courriel, musicien_courriel, objet, salle, jeton_atelier,"
            " jeton_musicien, debut_prevu, cree_le, expire_le)"
            " VALUES (:id,:commande_id,:projet_id,:atelier_id,:atelier_courriel,"
            ":musicien_courriel,:objet,:salle,:jeton_atelier,:jeton_musicien,"
            ":debut_prevu,:cree_le,:expire_le)",
            enregistrement,
        )

    return enregistrement


def lire_par_jeton(jeton: str) -> tuple[dict[str, Any] | None, str]:
    """Retourne (rendez-vous, role). Le role vaut 'atelier' ou 'musicien'."""
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


def purger_metadonnees(jours: int = 180) -> int:
    """Supprime les metadonnees des rendez-vous anciens. Minimisation RGPD."""
    limite = (datetime.now(timezone.utc) - timedelta(days=jours)).isoformat(timespec="seconds")
    with connexion() as conn:
        curseur = conn.execute("DELETE FROM rendez_vous WHERE cree_le < ?", (limite,))
        return curseur.rowcount


def executer_taches() -> dict[str, int]:
    """Rappels 24 h avant, puis purge. A appeler depuis web/taches.py."""
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

Aucune installation n'est necessaire. Le rendez-vous est gratuit et n'est
pas enregistre.

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
         font-size:.88rem}}
 button,.bouton{{display:block;width:100%;box-sizing:border-box;margin:.6rem 0;
   padding:.95rem 1rem;border-radius:11px;border:0;font-size:1rem;font-weight:600;
   text-align:center;text-decoration:none;cursor:pointer}}
 .oui{{background:#FFD166;color:#050814}}
 .non{{background:transparent;color:#94A3B8;border:1px solid #334155}}
 input,select,textarea{{width:100%;box-sizing:border-box;padding:.8rem;
   margin:.35rem 0 .9rem;border-radius:10px;border:1px solid #334155;
   background:#0B1220;color:#F8FAFC;font-size:1rem}}
 label{{font-size:.85rem;color:#94A3B8}}
 #salle{{width:100%;height:70vh;min-height:22rem;border:0;border-radius:14px;
         overflow:hidden;background:#000}}
</style></head><body><main>{corps}</main></body></html>"""
    return HTMLResponse(html)


# ---------------------------------------------------------------------------
# Cote atelier — proposer un rendez-vous
# ---------------------------------------------------------------------------

@routeur.get("/atelier/visio", response_class=HTMLResponse)
def formulaire_visio(atelier: str = "", courriel: str = "",
                     musicien: str = "", commande: str = "") -> HTMLResponse:
    options = "".join(
        f'<option value="{cle}">{libelle}</option>' for cle, libelle in OBJETS.items()
    )
    corps = f"""
<h1>Proposer un rendez-vous en visio</h1>
<div class="carte">
  <p class="note">Gratuit pour vous comme pour le musicien, sans limite de duree
  et sans logiciel a installer. Le rendez-vous <strong>n'est pas
  enregistre</strong> : Novaluth n'y assiste pas et n'en conserve aucun
  contenu.</p>
</div>
<form method="post" action="/atelier/visio">
  <label>Identifiant de votre atelier</label>
  <input name="atelier_id" value="{atelier}" required>
  <label>Votre adresse de contact</label>
  <input name="atelier_courriel" type="email" value="{courriel}" required>
  <label>Adresse du musicien</label>
  <input name="musicien_courriel" type="email" value="{musicien}" required>
  <label>Objet du rendez-vous</label>
  <select name="objet">{options}</select>
  <label>Date et heure proposees (facultatif)</label>
  <input name="debut_prevu" type="datetime-local">
  <label>Reference de commande, si elle existe (facultatif)</label>
  <input name="commande_id" value="{commande}">
  <button class="oui" type="submit">Creer le rendez-vous</button>
</form>
<p class="note">Deux liens personnels sont crees : un pour vous, un pour le
musicien. Ils sont valables {DUREE_VALIDITE_JOURS} jours.</p>"""
    return _page("Proposer un rendez-vous", corps)


@routeur.post("/atelier/visio")
def creer_visio(
    atelier_id: str = Form(...),
    atelier_courriel: str = Form(...),
    musicien_courriel: str = Form(...),
    objet: str = Form("projet"),
    debut_prevu: str = Form(""),
    commande_id: str = Form(""),
) -> HTMLResponse:
    rdv = creer_rendez_vous(
        atelier_id=atelier_id,
        atelier_courriel=atelier_courriel,
        musicien_courriel=musicien_courriel,
        objet=objet,
        commande_id=commande_id.strip() or None,
        debut_prevu=debut_prevu.strip() or None,
    )

    libelle = OBJETS.get(rdv["objet"], rdv["objet"])
    quand = rdv["debut_prevu"] or "a convenir entre vous"
    lien_musicien = f"{URL_BASE}/visio/{rdv['jeton_musicien']}"
    lien_atelier = f"{URL_BASE}/visio/{rdv['jeton_atelier']}"

    _envoyer(
        rdv["musicien_courriel"],
        "Un atelier vous propose un rendez-vous en visio",
        f"""Bonjour,

L'atelier avec lequel vous echangez sur Novaluth vous propose un rendez-vous
en visioconference.

Objet : {libelle}
Date  : {quand}

Votre lien personnel, a n'ouvrir qu'au moment du rendez-vous :
{lien_musicien}

Ce rendez-vous est gratuit. Aucune installation n'est necessaire : le lien
s'ouvre directement dans votre navigateur.

Le rendez-vous n'est pas enregistre. Novaluth n'y assiste pas, ne l'enregistre
pas et n'en conserve aucun contenu : seuls la date, l'objet et les
participants sont conserves pour organiser la rencontre.

Vous pouvez decliner ce rendez-vous sans aucune consequence : il ne conditionne
ni un devis, ni une commande.

Novaluth""",
    )
    _envoyer(
        rdv["atelier_courriel"],
        "Votre rendez-vous en visio est cree",
        f"""Le rendez-vous « {libelle} » est cree.

Date : {quand}

Votre lien personnel :
{lien_atelier}

Le musicien a recu son propre lien. Conseil : ayez sous la main vos
echantillons de bois, vos nuanciers de finition et un instrument termine —
c'est ce qui rend ce rendez-vous decisif.

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
<p class="note">Le musicien a recu son lien par courriel. Le votre aussi.</p>
<a class="bouton oui" href="/visio/{rdv['jeton_atelier']}">Ouvrir la salle maintenant</a>
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
    affichage = "Atelier" if role == "atelier" else "Musicien"
    salle_js = quote(rdv["salle"])

    tete = f'<script src="{JITSI_SCRIPT}"></script>'
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
  <p class="note">Ce rendez-vous ne cree aucun engagement. Seul un devis ecrit
  et signe engage les parties. Novaluth n'est pas partie au contrat de
  fabrication.</p>
</div>
<a class="bouton non" href="/">Quitter</a>
<script>
(function () {{
  var domaine = "{JITSI_DOMAINE}";
  var options = {{
    roomName: "{salle_js}",
    parentNode: document.getElementById("salle"),
    userInfo: {{ displayName: "{affichage}" }},
    configOverwrite: {{
      prejoinPageEnabled: true,
      disableDeepLinking: true,
      localRecording: {{ enabled: false }},
      fileRecordingsEnabled: false,
      liveStreamingEnabled: false,
      transcribingEnabled: false,
      disableThirdPartyRequests: true
    }},
    interfaceConfigOverwrite: {{
      TOOLBAR_BUTTONS: [
        "microphone", "camera", "desktop", "fullscreen", "hangup",
        "chat", "tileview", "select-background", "toggle-camera", "settings"
      ],
      SHOW_JITSI_WATERMARK: false,
      DEFAULT_BACKGROUND: "#050814"
    }}
  }};
  try {{
    var api = new JitsiMeetExternalAPI(domaine, options);
    api.addEventListener("readyToClose", function () {{ window.location.href = "/"; }});
  }} catch (e) {{
    document.getElementById("salle").innerHTML =
      '<div style="padding:1.5rem;color:#CBD5E1">' +
      "La salle n'a pas pu s'ouvrir dans l'application. " +
      '<a style="color:#FFD166" href="https://{JITSI_DOMAINE}/{salle_js}">' +
      "Ouvrir dans le navigateur</a>.</div>";
  }}
}})();
</script>"""
    return _page(libelle, corps, tete)


# ---------------------------------------------------------------------------
# Solution de repli iPhone : ouvrir hors de la PWA
# ---------------------------------------------------------------------------

@routeur.get("/visio/{jeton}/externe", response_class=HTMLResponse)
def salle_externe(jeton: str) -> HTMLResponse:
    """Si la camera est bloquee dans la PWA installee, on sort vers Safari."""
    rdv, _ = lire_par_jeton(jeton)
    if rdv is None:
        raise HTTPException(status_code=404, detail="Rendez-vous introuvable")
    lien = f"https://{JITSI_DOMAINE}/{quote(rdv['salle'])}"
    corps = f"""
<h1>Ouvrir dans le navigateur</h1>
<div class="carte">
  <p>Si la camera ou le micro ne fonctionnent pas depuis l'application
  installee sur votre ecran d'accueil, ouvrez la salle directement dans
  votre navigateur.</p>
</div>
<a class="bouton oui" href="{lien}" target="_blank" rel="noopener">
  Ouvrir la salle dans le navigateur</a>
<a class="bouton non" href="/visio/{jeton}">Revenir</a>
<p class="note">Cet appel n'est pas enregistre par Novaluth.</p>"""
    return _page("Ouvrir dans le navigateur", corps)


# ---------------------------------------------------------------------------
# Tableau de bord atelier
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
<p class="note">Les rendez-vous sont gratuits, sans limite de duree, et ne sont
jamais enregistres par Novaluth.</p>"""
    return _page("Vos rendez-vous", corps)


@routeur.post("/atelier/visio/{rdv_id}/annuler")
def annuler_visio(rdv_id: str) -> HTMLResponse:
    annuler(rdv_id)
    return _page("Annule",
                 '<h1>Rendez-vous annule</h1><div class="carte">'
                 "<p>Les deux liens sont desormais inactifs.</p></div>")


if __name__ == "__main__":
    initialiser()
    print("Table rendez_vous prete.")
    print("Serveur Jitsi :", JITSI_DOMAINE)
    print("Objets disponibles :", ", ".join(OBJETS))
