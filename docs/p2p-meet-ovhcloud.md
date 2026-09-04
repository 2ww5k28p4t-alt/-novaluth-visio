# NovaLuth Meet — relais TURN sur OVHcloud

Ce guide reprend la mise à jour de déploiement OVHcloud fournie avec
l’archive `p2p-meet`, mais l’adapte à l’architecture NovaLuth actuelle :

- l’application NovaLuth et sa signalisation Socket.IO restent déployées sur
  Replit ;
- OVHcloud héberge uniquement Coturn, le relais réseau WebRTC ;
- aucun compte utilisateur, aucune session NovaLuth et aucun média ne sont
  stockés sur le serveur TURN ;
- le média reste chiffré de navigateur à navigateur, même lorsqu’il passe par
  Coturn.

Le relais TURN est nécessaire pour les appels entre réseaux mobiles, NAT
stricts et certains pare-feu d’entreprise. Il ne remplace pas la signalisation
Socket.IO.

## Voie express — installateur Coturn

Le dépôt contient `scripts/install-coturn-ovh.sh`. Il installe et configure
uniquement Coturn sur le VPS, sans copier l’application NovaLuth ni ses
comptes. Les prérequis manuels sont :

1. commander le VPS ;
2. créer `turn.novaluth.com` vers son IPv4 ;
3. se connecter en SSH et vérifier que la clé fonctionne ;
4. lancer le script depuis une copie du dépôt.

Depuis le serveur, avec le script présent dans le dépôt :

```bash
sudo bash scripts/install-coturn-ovh.sh
```

Le script vérifie le DNS, demande le secret TURN sans l’afficher, obtient le
certificat Let's Encrypt, applique le pare-feu, écrit la configuration
Coturn, active son renouvellement et vérifie les ports d’écoute. Il est
relançable uniquement si la configuration existante correspond exactement aux
paramètres demandés : secret TURN, `external-ip`, `realm`, `server-name` et
les chemins `cert`/`pkey`. Une divergence (par exemple après un changement
d’adresse IP ou de domaine) arrête l’installation avant toute modification de
la configuration existante et exige une migration explicite ; le script ne
réutilise pas silencieusement des valeurs Coturn obsolètes.

### Migration volontaire d’adresse IP ou de domaine

Une migration n’est pas une réinstallation idempotente. Préparer d’abord la
nouvelle destination sans arrêter l’ancien relais :

1. mettre à jour l’enregistrement DNS `A` et attendre que
   `dig +short NOUVEAU_DOMAINE` renvoie la nouvelle IPv4 ;
2. si le domaine change, vérifier que le port 80 du nouveau VPS est accessible
   afin que Certbot puisse obtenir un certificat couvrant ce nouveau domaine ;
3. conserver le même secret TURN pendant la migration et le saisir à l’invite,
   sans l’ajouter à la commande ni à l’historique du shell ;
4. lancer explicitement :

```bash
sudo env \
  TURN_DOMAIN=NOUVEAU_DOMAINE \
  PUBLIC_IP=NOUVELLE_IP \
  CERTBOT_EMAIL=adresse-operateur@example.com \
  TURN_MIGRATION_CONFIRM=MIGRATE_TURN_CONFIGURATION \
  bash scripts/install-coturn-ovh.sh
```

Le script refuse toute migration sans cette phrase exacte. Il vérifie le DNS,
obtient ou contrôle le certificat et valide toutes les valeurs de la
configuration candidate avant de toucher à `/etc/turnserver.conf`. Il crée
ensuite une sauvegarde protégée
`/etc/turnserver.conf.backup.<horodatage UTC>`, remplace atomiquement la
configuration, puis redémarre Coturn. Le chemin de sauvegarde est affiché,
jamais le secret TURN.

Après le redémarrage réussi, mettre à jour les Secrets NovaLuth :

- `TURN_HOST` avec le nouveau domaine ;
- conserver `TURN_STATIC_AUTH_SECRET` avec la même valeur secrète, sans
  l’afficher ni la recopier dans un journal ou une commande ;
- laisser `TURN_TLS_443=false`, sauf si un véritable écouteur Coturn sur 443 a
  été configuré et vérifié.

Relancer ensuite le service API NovaLuth, contrôler `/api/meet/ice`, puis
effectuer un appel depuis deux réseaux distincts. Ne retirer l’ancien DNS,
l’ancien certificat ou l’ancien relais qu’après ces contrôles. En cas
d’échec après remplacement, la sauvegarde indiquée permet à l’opérateur de
restaurer manuellement la configuration antérieure.

Le script n’active pas le port 443. Le relais TLS standard écoute sur 5349.
N’activer `TURN_TLS_443=true` dans Replit qu’après avoir configuré et vérifié
un écouteur Coturn réel sur 443.

Avant de transférer une nouvelle version du script sur un VPS, lancer :

```bash
pnpm run test:coturn-installer
```

Ce contrôle utilise uniquement des répertoires et commandes simulés. Il vérifie
la syntaxe, les ports, le refus d’un DNS incorrect, le refus d’écraser un
secret existant, le refus d’une IP ou d’un domaine devenus obsolètes, une
migration explicitement confirmée avec sauvegarde, une installation complète
et une seconde exécution idempotente avec les mêmes paramètres. Il ne demande
aucun secret réel et ne contacte aucun serveur public.

## 1. Préparer le serveur

Commander un VPS européen, par exemple un VPS OVHcloud sous Debian 12, avec
une IPv4 publique dédiée. Gravelines et Strasbourg conviennent au besoin de
localisation européenne.

Créer ensuite un enregistrement DNS :

```text
Type   Nom    Cible
A      turn   IP_PUBLIQUE_DU_VPS
```

Vérifier la propagation avant de continuer :

```bash
dig +short turn.novaluth.com
```

La commande doit renvoyer l’adresse IPv4 du VPS.

Sur le serveur, appliquer les mises à jour et installer Coturn :

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y coturn ufw openssl
```

## 2. Ouvrir uniquement les ports nécessaires

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 3478/tcp comment 'TURN'
sudo ufw allow 3478/udp comment 'TURN'
sudo ufw allow 5349/tcp comment 'TURN TLS'
sudo ufw allow 5349/udp comment 'TURN DTLS'
sudo ufw allow 49160:49200/udp comment 'Relais TURN'
sudo ufw --force enable
sudo ufw status numbered
```

Le port `443` n’est pas nécessaire dans la configuration standard. Ne
l’ajouter que si Coturn écoute effectivement sur ce port et qu’aucun autre
service ne l’utilise.

## 3. Générer le secret partagé

Générer un secret distinct pour Coturn et NovaLuth :

```bash
openssl rand -hex 32
```

Conserver cette valeur dans un gestionnaire de mots de passe. Elle ne doit
pas être collée dans le dépôt, dans une conversation ou dans un fichier
public.

Dans les Secrets de l’environnement NovaLuth, renseigner :

| Variable | Valeur |
|---|---|
| `TURN_HOST` | `turn.novaluth.com` |
| `TURN_STATIC_AUTH_SECRET` | le secret généré ci-dessus |
| `TURN_TTL` | `43200` |
| `TURN_TLS_443` | `false` par défaut |

Le nom `TURN_TLS_443` est volontairement explicite : il ne doit passer à
`true` que si Coturn est configuré avec un écouteur TLS réel sur le port 443.
Cette option ne doit pas être activée simplement parce que le port est
habituellement utilisé par HTTPS.

## 4. Configurer Coturn

Créer `/etc/turnserver.conf` avec les valeurs suivantes, en remplaçant les
deux marqueurs :

```ini
listening-ip=0.0.0.0
external-ip=IP_PUBLIQUE_DU_VPS
listening-port=3478
tls-listening-port=5349

realm=turn.novaluth.com
server-name=turn.novaluth.com

use-auth-secret
static-auth-secret=SECRET_TURN

cert=/etc/letsencrypt/live/turn.novaluth.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.novaluth.com/privkey.pem

min-port=49160
max-port=49200

no-multicast-peers
no-tcp-relay
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=240.0.0.0-255.255.255.255

user-quota=12
total-quota=1200
max-bps=1000000
log-file=syslog
simple-log
```

Protéger le fichier :

```bash
sudo chmod 600 /etc/turnserver.conf
sudo systemctl enable coturn
```

## 5. Certificat TLS du relais

Le certificat doit couvrir `turn.novaluth.com`. Utiliser un certificat
Let's Encrypt ou un certificat fourni par l’hébergeur, puis renseigner les
chemins `cert` et `pkey` dans la configuration Coturn.

Avant de démarrer, vérifier :

```bash
sudo test -r /etc/letsencrypt/live/turn.novaluth.com/fullchain.pem
sudo test -r /etc/letsencrypt/live/turn.novaluth.com/privkey.pem
sudo grep -E '^(external-ip|static-auth-secret|tls-listening-port)' /etc/turnserver.conf
```

Redémarrer Coturn :

```bash
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
sudo journalctl -u coturn -n 50 --no-pager
```

## 6. Vérifier NovaLuth

Après l’enregistrement des Secrets et une nouvelle exécution du service API,
contrôler la réponse :

```bash
curl -s https://novaluth.com/api/meet/ice | jq .
```

La réponse ne doit jamais contenir le secret partagé. Elle doit contenir un
identifiant `username` temporaire et une `credential` HMAC lorsque Coturn est
configuré.

Vérifier également :

```bash
curl -s https://novaluth.com/api/healthz
```

Attendu :

```json
{"status":"ok"}
```

Dans le navigateur, ouvrir `/meet` depuis deux réseaux distincts, par exemple
un Wi-Fi domestique et un réseau mobile. Dans les outils WebRTC du navigateur,
un candidat ICE de type `relay` doit apparaître lorsque la connexion directe
n’est pas possible.

## 7. Diagnostic

### Aucun candidat `relay`

Vérifier dans cet ordre :

1. `dig +short turn.novaluth.com` pointe vers le bon VPS ;
2. les ports UFW `3478`, `5349` et `49160:49200/udp` sont ouverts ;
3. `external-ip` contient l’IPv4 publique réelle du VPS ;
4. `static-auth-secret` correspond exactement à
   `TURN_STATIC_AUTH_SECRET` dans NovaLuth ;
5. les certificats Coturn sont lisibles et valides ;
6. `systemctl status coturn` et `journalctl -u coturn` ne signalent pas
   d’erreur.

### Appel fonctionnel en local mais pas sur réseau mobile

Vérifier que le relais utilise bien `turn:` sur UDP et TCP, ainsi que
`turns:` sur le port `5349`. Le port 443 ne doit être ajouté qu’après avoir
confirmé que Coturn l’écoute réellement.

Pour un test temporaire, `FORCE_RELAY=true` peut être activé dans les Secrets
NovaLuth. Le remettre à `false` après le test afin de privilégier les
connexions directes lorsque cela est possible.

### Sécurité

- Ne jamais utiliser `TURN_USERNAME` et `TURN_PASSWORD` permanents en
  production lorsque l’authentification par secret partagé est disponible.
- Ne pas activer `alt-tls-listening-port=443` sans ouvrir le port et vérifier
  qu’aucun reverse proxy ne l’utilise.
- Ne pas installer l’application complète NovaLuth ni son stockage de comptes
  sur le VPS TURN.
- Les journaux Coturn doivent être purgés selon la politique de rétention
  applicable à l’hébergement.