"""Novaluth — routes du modele « Commande protegee ».

Brancher dans web/main.py :

    from web import commandes as commandes_routes
    app.include_router(commandes_routes.routeur)

    @app.on_event("startup")
    def _demarrage():
        from web import store_commandes
        store_commandes.initialiser()

A placer dans : novaluth/web/commandes.py
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from web import store_commandes as sc

routeur = APIRouter(tags=["commandes"])

URL_BASE = os.environ.get("NOVALUTH_URL", "http://localhost:8000").rstrip("/")
DOSSIER_COURRIELS = Path(__file__).resolve().parent.parent / "data" / "courriels"


# ---------------------------------------------------------------------------
# Envoi de courriel — reutilise web/courriel.py s'il existe, sinon ecrit un
# fichier lisible depuis l'onglet Files de Replit.
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
    horodatage = sc.maintenant().replace(":", "-")
    fichier = DOSSIER_COURRIELS / f"{horodatage}_{destinataire.replace('@', '_at_')}.txt"
    fichier.write_text(f"A: {destinataire}\nObjet: {sujet}\n\n{corps}\n", encoding="utf-8")


def _page(titre: str, corps: str) -> HTMLResponse:
    html = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{titre} — Novaluth</title>
<style>
 body{{margin:0;background:#050814;color:#F8FAFC;
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}}
 main{{max-width:34rem;margin:0 auto;padding:2rem 1.25rem 4rem}}
 h1{{font-size:1.35rem;letter-spacing:.02em;margin:0 0 1rem}}
 .carte{{background:#0B1220;border:1px solid #1E293B;border-radius:14px;
         padding:1.25rem;margin:1rem 0}}
 dl{{margin:0}} dt{{color:#94A3B8;font-size:.82rem;margin-top:.75rem}}
 dd{{margin:.15rem 0 0;font-weight:600}}
 .note{{color:#94A3B8;font-size:.85rem}}
 button,.bouton{{display:block;width:100%;box-sizing:border-box;margin:.6rem 0;
   padding:.95rem 1rem;border-radius:11px;border:0;font-size:1rem;font-weight:600;
   text-align:center;text-decoration:none;cursor:pointer}}
 .oui{{background:#FFD166;color:#050814}}
 .non{{background:transparent;color:#94A3B8;border:1px solid #334155}}
 input,textarea{{width:100%;box-sizing:border-box;padding:.8rem;margin:.35rem 0 .9rem;
   border-radius:10px;border:1px solid #334155;background:#0B1220;color:#F8FAFC;
   font-size:1rem}}
 label{{font-size:.85rem;color:#94A3B8}}
</style></head><body><main>{corps}</main></body></html>"""
    return HTMLResponse(html)


# ---------------------------------------------------------------------------
# Cote atelier — declarer une commande
# ---------------------------------------------------------------------------

@routeur.get("/atelier/commande", response_class=HTMLResponse)
def formulaire_commande(atelier: str = "", courriel: str = "") -> HTMLResponse:
    corps = f"""
<h1>Declarer une commande</h1>
<div class="carte">
  <p class="note">Vous ne payez rien tant que le musicien n'a pas confirme.
  A la confirmation : <strong>{sc.euros(sc.FRAIS_ENGAGEMENT_CENTS)}</strong> de frais
  d'engagement. La commission de {int(sc.TAUX_COMMISSION * 100)} %
  (plafond {sc.euros(sc.PLAFOND_COMMISSION_CENTS)}) n'est due qu'apres confirmation
  de reception par le musicien.</p>
</div>
<form method="post" action="/atelier/commande">
  <label>Identifiant de votre atelier</label>
  <input name="atelier_id" value="{atelier}" required>
  <label>Votre adresse de contact</label>
  <input name="atelier_courriel" type="email" value="{courriel}" required>
  <label>Adresse du musicien</label>
  <input name="musicien_courriel" type="email" required>
  <label>Prix de l'instrument, en euros</label>
  <input name="prix_euros" type="number" step="0.01" min="1" required>
  <label>Acompte deja verse, en euros (facultatif)</label>
  <input name="acompte_euros" type="number" step="0.01" min="0">
  <label>Reference du devis (facultatif)</label>
  <input name="devis_reference">
  <label>Date de livraison annoncee, AAAA-MM-JJ (facultatif)</label>
  <input name="date_livraison" placeholder="2027-06-30">
  <label>Description de l'instrument</label>
  <textarea name="description" rows="3"></textarea>
  <button class="oui" type="submit">Declarer la commande</button>
</form>
<p class="note">Le musicien recevra une demande de confirmation. Sans sa reponse
sous {sc.DELAI_CONFIRMATION_COMMANDE_JOURS} jours, la declaration expire et rien
n'est facture.</p>"""
    return _page("Declarer une commande", corps)


@routeur.post("/atelier/commande")
def creer_commande(
    atelier_id: str = Form(...),
    atelier_courriel: str = Form(...),
    musicien_courriel: str = Form(...),
    prix_euros: float = Form(...),
    acompte_euros: float | None = Form(None),
    devis_reference: str = Form(""),
    date_livraison: str = Form(""),
    description: str = Form(""),
) -> HTMLResponse:
    prix_cents = int(round(prix_euros * 100))
    acompte_cents = int(round(acompte_euros * 100)) if acompte_euros else None

    try:
        resultat = sc.declarer_commande(
            atelier_id=atelier_id.strip(),
            atelier_courriel=atelier_courriel,
            musicien_courriel=musicien_courriel,
            prix_instrument_cents=prix_cents,
            acompte_cents=acompte_cents,
            devis_reference=devis_reference.strip() or None,
            description=description.strip() or None,
            date_livraison_annoncee=date_livraison.strip() or None,
        )
    except ValueError as erreur:
        return _page("Impossible", f'<h1>Impossible</h1><div class="carte"><p>{erreur}</p></div>')

    lien = f"{URL_BASE}/commande/{resultat['jeton_musicien']}"
    _envoyer(
        musicien_courriel,
        "Confirmez votre commande d'instrument",
        f"""Bonjour,

L'atelier avec lequel vous echangez sur Novaluth declare avoir recu votre commande.

Merci de confirmer, ou d'indiquer que ce n'est pas le cas :
{lien}

Cette confirmation est gratuite pour vous. Novaluth n'est pas partie au contrat
de fabrication : le devis, le paiement, la livraison et les garanties restent
entre vous et l'atelier.

Sans reponse de votre part sous {sc.DELAI_CONFIRMATION_COMMANDE_JOURS} jours, la
declaration est annulee et l'atelier n'est pas facture.

Novaluth""",
    )

    corps = f"""
<h1>Declaration enregistree</h1>
<div class="carte">
  <p>Le musicien a recu une demande de confirmation.</p>
  <dl>
    <dt>Frais d'engagement, dus seulement s'il confirme</dt>
    <dd>{sc.euros(resultat['frais_engagement_cents'])}</dd>
    <dt>Commission prevue, due seulement a la livraison confirmee</dt>
    <dd>{sc.euros(resultat['commission_prevue_cents'])}</dd>
  </dl>
</div>
<p class="note">Aucune somme n'est debitee pour l'instant.</p>
<a class="bouton non" href="/atelier/commande">Declarer une autre commande</a>"""
    return _page("Declaration enregistree", corps)


# ---------------------------------------------------------------------------
# Cote musicien — confirmer ou refuser la commande
# ---------------------------------------------------------------------------

@routeur.get("/commande/{jeton}", response_class=HTMLResponse)
def page_confirmation(jeton: str) -> HTMLResponse:
    commande = sc.lire_par_jeton(jeton)
    if commande is None:
        raise HTTPException(status_code=404, detail="Commande introuvable")

    if commande["etat"] != "declaree":
        libelles = {
            "confirmee": "Vous avez confirme cette commande. Merci.",
            "expiree": "Le delai de confirmation est depasse. Aucun frais n'a ete applique.",
            "refusee": "Vous avez indique ne pas avoir passe cette commande.",
            "livree": "La reception de l'instrument est confirmee.",
            "annulee_client": "Cette commande a ete annulee.",
            "annulee_atelier": "L'atelier a interrompu cette commande.",
            "non_confirmee": "La reception n'a pas ete confirmee dans les delais.",
        }
        message = libelles.get(commande["etat"], "Cette commande est close.")
        return _page("Commande", f'<h1>Commande</h1><div class="carte"><p>{message}</p></div>')

    corps = f"""
<h1>Confirmez-vous cette commande ?</h1>
<div class="carte">
  <dl>
    <dt>Instrument</dt><dd>{commande['description'] or 'non precise'}</dd>
    <dt>Prix annonce</dt><dd>{sc.euros(commande['prix_instrument_cents'])}</dd>
    <dt>Devis</dt><dd>{commande['devis_reference'] or 'non precise'}</dd>
    <dt>Livraison annoncee</dt><dd>{commande['date_livraison_annoncee'] or 'non precisee'}</dd>
  </dl>
</div>
<form method="post" action="/commande/{jeton}/confirmer">
  <button class="oui" type="submit">Oui, j'ai passe cette commande</button>
</form>
<form method="post" action="/commande/{jeton}/refuser">
  <button class="non" type="submit">Non, je n'ai pas commande</button>
</form>
<p class="note">Cette page est gratuite. Novaluth ne vous facture jamais rien et
n'est pas partie au contrat conclu avec l'atelier.</p>"""
    return _page("Confirmer la commande", corps)


@routeur.post("/commande/{jeton}/confirmer")
def valider_commande(jeton: str) -> HTMLResponse:
    try:
        commande = sc.confirmer_commande(jeton)
    except ValueError as erreur:
        raise HTTPException(status_code=404, detail=str(erreur))

    if commande["etat"] == "expiree":
        return _page("Delai depasse",
                     '<h1>Delai depasse</h1><div class="carte"><p>La declaration a expire. '
                     'Aucun frais n\'a ete applique a l\'atelier.</p></div>')

    lien_livraison = f"{URL_BASE}/livraison/{commande['jeton_livraison']}"
    _envoyer(
        commande["musicien_courriel"],
        "Commande confirmee — a garder pour la reception",
        f"""Merci d'avoir confirme votre commande.

Quand vous recevrez votre instrument, confirmez la reception ici :
{lien_livraison}

Conservez ce lien. Novaluth n'est pas partie au contrat : le paiement, la
livraison et les garanties restent entre vous et l'atelier.

Novaluth""",
    )
    _envoyer(
        commande["atelier_courriel"],
        "Commande confirmee par le musicien",
        f"""Le musicien a confirme la commande {commande['id'][:8]}.

Frais d'engagement encaisses : {sc.euros(commande['frais_engagement_cents'])}
Commission a la livraison confirmee : {sc.euros(commande['commission_cents'])}

La commission ne sera due qu'apres confirmation de reception par le musicien.
Sans confirmation dans les {sc.DELAI_CONFIRMATION_LIVRAISON_JOURS} jours suivant
la date de livraison annoncee, elle n'est pas due.

Novaluth""",
    )

    corps = f"""
<h1>Commande confirmee</h1>
<div class="carte">
  <p>Merci. Vous recevrez un lien pour confirmer la reception de l'instrument
  le moment venu.</p>
</div>
<p class="note">Gardez le courriel que nous venons de vous envoyer : il contient
le lien de confirmation de reception.</p>"""
    return _page("Commande confirmee", corps)


@routeur.post("/commande/{jeton}/refuser")
def decliner_commande(jeton: str) -> HTMLResponse:
    try:
        sc.refuser_commande(jeton, "declaration contestee par le musicien")
    except ValueError as erreur:
        raise HTTPException(status_code=404, detail=str(erreur))
    return _page(
        "Merci",
        '<h1>Merci</h1><div class="carte"><p>Nous avons enregistre votre reponse. '
        "L'atelier n'est pas facture et la declaration est close.</p></div>",
    )


# ---------------------------------------------------------------------------
# Cote musicien — confirmer la reception
# ---------------------------------------------------------------------------

@routeur.get("/livraison/{jeton}", response_class=HTMLResponse)
def page_livraison(jeton: str) -> HTMLResponse:
    commande = sc.lire_par_jeton(jeton, "jeton_livraison")
    if commande is None:
        raise HTTPException(status_code=404, detail="Commande introuvable")

    if commande["etat"] == "livree":
        return _page("Reception confirmee",
                     '<h1>Reception confirmee</h1><div class="carte">'
                     "<p>Merci, c'est deja enregistre.</p></div>")
    if commande["etat"] != "confirmee":
        return _page("Commande close",
                     '<h1>Commande close</h1><div class="carte">'
                     "<p>Cette commande n'est plus en cours.</p></div>")

    corps = f"""
<h1>Avez-vous recu votre instrument ?</h1>
<div class="carte">
  <dl>
    <dt>Instrument</dt><dd>{commande['description'] or 'non precise'}</dd>
    <dt>Prix</dt><dd>{sc.euros(commande['prix_instrument_cents'])}</dd>
  </dl>
</div>
<form method="post" action="/livraison/{jeton}/confirmer">
  <button class="oui" type="submit">Oui, j'ai recu l'instrument</button>
</form>
<p class="note">Ne confirmez que si l'instrument est bien entre vos mains.
Cette confirmation ne vaut pas renonciation a vos garanties legales : la garantie
de conformite et celle des vices caches restent entierement applicables aupres de
l'atelier.</p>"""
    return _page("Confirmer la reception", corps)


@routeur.post("/livraison/{jeton}/confirmer")
def valider_livraison(jeton: str) -> HTMLResponse:
    try:
        commande = sc.confirmer_livraison(jeton)
    except ValueError as erreur:
        raise HTTPException(status_code=400, detail=str(erreur))

    _envoyer(
        commande["atelier_courriel"],
        "Reception confirmee par le musicien",
        f"""Le musicien confirme avoir recu l'instrument.

Commande : {commande['id'][:8]}
Commission encaissee : {sc.euros(commande['commission_cents'])}
Total Novaluth sur cette commande : {sc.euros(
    commande['frais_engagement_cents'] + commande['commission_cents'])}

Merci, et bravo pour cette realisation.

Novaluth""",
    )

    return _page(
        "Merci",
        '<h1>Merci</h1><div class="carte"><p>Reception enregistree. '
        "Vos garanties legales aupres de l'atelier restent entierement applicables."
        "</p></div>",
    )


# ---------------------------------------------------------------------------
# Tableau de bord atelier
# ---------------------------------------------------------------------------

@routeur.get("/atelier/{atelier_id}/commandes", response_class=HTMLResponse)
def tableau_atelier(atelier_id: str) -> HTMLResponse:
    lignes = sc.commandes_atelier(atelier_id)
    credit = sc.credits_disponibles(atelier_id)

    if not lignes:
        contenu = '<div class="carte"><p>Aucune commande declaree.</p></div>'
    else:
        contenu = ""
        for c in lignes:
            du = 0
            if c["etat"] in sc.ETATS_FACTURES:
                du = c["frais_engagement_cents"] + c["commission_cents"]
            contenu += f"""<div class="carte">
  <dl>
    <dt>Commande</dt><dd>{c['id'][:8]}</dd>
    <dt>Etat</dt><dd>{c['etat']}</dd>
    <dt>Prix de l'instrument</dt><dd>{sc.euros(c['prix_instrument_cents'])}</dd>
    <dt>Facture par Novaluth</dt><dd>{sc.euros(du)}</dd>
  </dl></div>"""

    corps = f"""
<h1>Vos commandes</h1>
<div class="carte">
  <dl>
    <dt>Credit d'annulation disponible</dt><dd>{sc.euros(credit)}</dd>
    <dt>Frais d'engagement</dt><dd>{sc.euros(sc.FRAIS_ENGAGEMENT_CENTS)} par commande confirmee</dd>
    <dt>Commission</dt><dd>{int(sc.TAUX_COMMISSION * 100)} %, plafond {sc.euros(sc.PLAFOND_COMMISSION_CENTS)}</dd>
  </dl>
</div>
{contenu}
<a class="bouton oui" href="/atelier/commande?atelier={atelier_id}">Declarer une commande</a>"""
    return _page("Vos commandes", corps)


@routeur.get("/admin/commandes/statistiques")
def stats() -> dict:
    return sc.statistiques()
