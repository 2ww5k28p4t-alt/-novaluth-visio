Option 1 retenue : envoi SMTP via Resend, sans nouveau code.

Le projet possède déjà un module d'envoi complet et testé : `web/courriel.py`. Il envoie en SMTP + STARTTLS, dispose d'un mode de repli qui écrit les messages dans `data/courriels/`, journalise chaque envoi via `store.journaliser()`, et contient déjà toutes les fonctions de message du circuit (confirmation de projet, demande d'acceptation, coordonnées transmises, accès annulé, relance de fraîcheur, vérification avant crédit, crédit accordé, lien de connexion atelier).

NE CRÉE PAS un second système d'envoi. NE RÉÉCRIS PAS `web/courriel.py`. N'introduis pas l'API HTTP de Resend. Le travail à faire est uniquement de la configuration.

## 1. Variables d'environnement à enregistrer

Respecte exactement ces noms, ce sont ceux que le code lit déjà (voir `.env.example`) :

    NOVALUTH_SMTP_HOTE=smtp.resend.com
    NOVALUTH_SMTP_PORT=587
    NOVALUTH_SMTP_UTILISATEUR=resend
    NOVALUTH_EXPEDITEUR=contact@novaluth.com

Pour `NOVALUTH_SMTP_MOTDEPASSE`, reprends la valeur du secret `RESEND_API_KEY` déjà présent dans le coffre. Ne l'affiche pas, ne la recopie pas en clair dans un fichier, ne la mets pas dans un log.

Deux points à ne pas modifier :

- `NOVALUTH_SMTP_UTILISATEUR` vaut le mot littéral `resend`, en minuscules. Ce n'est pas une adresse e-mail ni un nom de domaine. C'est la même valeur pour tous les comptes Resend.
- `NOVALUTH_SMTP_PORT` vaut 587, pas 465. Le code appelle `serveur.starttls()` sur une connexion `smtplib.SMTP` classique, ce qui correspond au mode STARTTLS. Avec 465 la connexion échouerait et l'erreur serait seulement tracée dans le journal.

## 2. URL publique

Renseigne `NOVALUTH_URL` avec l'URL publique HTTPS de l'application déployée, sans barre oblique finale.

Cette variable sert à fabriquer les liens privés envoyés aux musiciens et aux ateliers. Si elle est fausse, les liens de confirmation ne fonctionnent pas et le circuit de consentement est cassé.

Tant que le nom de domaine `novaluth.com` n'est pas rattaché au déploiement Replit, utilise l'URL Replit du déploiement, pas `https://novaluth.com`.

## 3. Variables en doublon à supprimer

Si tu as créé `NOVALUTH_EMAIL_FROM` ou `NOVALUTH_PUBLIC_URL`, supprime-les. Elles font doublon avec `NOVALUTH_EXPEDITEUR` et `NOVALUTH_URL`, que le code lit déjà. Deux jeux de noms concurrents mèneraient à une configuration silencieusement inactive.

Le secret `RESEND_API_KEY` peut rester dans le coffre, il n'est simplement plus lu par le code. Ne l'efface pas.

## 4. Vérification, dans cet ordre

Exécute d'abord :

    python -c "from web import courriel; print(courriel.envoi_reel_actif())"

Le résultat attendu est `True`. S'il vaut `False`, c'est qu'au moins une des trois variables `NOVALUTH_SMTP_HOTE`, `NOVALUTH_SMTP_UTILISATEUR`, `NOVALUTH_SMTP_MOTDEPASSE` est absente ou vide. Corrige-la et recommence, sans toucher au code.

Envoie ensuite un seul message de test réel :

    python -c "from web import courriel; print(courriel.envoyer('contact@novaluth.com', 'Test SMTP Novaluth', 'Ceci est un test de configuration.', 'test_smtp'))"

Un seul envoi, pas de boucle, pas de test en masse.

Montre-moi enfin les dernières lignes du journal produites par ce test. Je veux voir l'événement enregistré : `envoye`, `echec_envoi`, ou `ecrit_localement`.

Si le résultat est `echec_envoi`, indique-moi le type d'exception qui a été tracé, et ne tente pas de contourner le problème en changeant de méthode d'envoi.

## 5. Interdits pour cette tâche

- Ne modifie pas `common/paiement.py` ni le circuit de paiement à acceptation.
- Ne modifie aucun fichier de `legal/`.
- Ne modifie pas les textes des messages dans `web/courriel.py`, y compris le pied de page légal.
- N'ajoute aucune dépendance dans `requirements.txt` : `smtplib` fait partie de la bibliothèque standard.
- N'envoie aucun message à une adresse autre que `contact@novaluth.com` pendant les tests.
