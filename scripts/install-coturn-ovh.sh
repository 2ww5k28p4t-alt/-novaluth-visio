#!/usr/bin/env bash
#
# NovaLuth Meet — installation de Coturn sur un VPS OVHcloud
#
# Ce script installe uniquement le relais TURN. L'application NovaLuth,
# ses comptes, ses sessions et sa signalisation restent sur Replit.
#
# Usage :
#   sudo bash scripts/install-coturn-ovh.sh
#
# Variables facultatives :
#   TURN_DOMAIN=turn.novaluth.com
#   PUBLIC_IP=1.2.3.4
#   CERTBOT_EMAIL=contact@example.com
#   TURN_MIGRATION_CONFIRM=MIGRATE_TURN_CONFIGURATION
#
set -euo pipefail
umask 077

TURN_DOMAIN="${TURN_DOMAIN:-turn.novaluth.com}"
PUBLIC_IP="${PUBLIC_IP:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
TURN_MIGRATION_CONFIRM="${TURN_MIGRATION_CONFIRM:-}"
TEST_ROOT="${NOVALUTH_COTURN_TEST_ROOT:-}"
ETC_DIR="$TEST_ROOT/etc"
CONFIG_FILE="$ETC_DIR/turnserver.conf"
CERT_DIR="$ETC_DIR/letsencrypt/live/$TURN_DOMAIN"
DEFAULT_FILE="$ETC_DIR/default/coturn"
RENEWAL_FILE="$ETC_DIR/cron.d/novaluth-coturn-cert"
MIGRATION_MODE=0
CONFIG_MISMATCHES=()

title() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok() { printf '   \033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '\n\033[31mArrêt : %s\033[0m\n\n' "$*" >&2; exit 1; }

[ -z "$TEST_ROOT" ] || [ "${NOVALUTH_COTURN_TEST_MODE:-}" = "1" ] ||
  fail "NOVALUTH_COTURN_TEST_ROOT est réservé aux tests automatisés"

[ "$(id -u)" -eq 0 ] || fail "lancez le script avec sudo"
command -v apt-get >/dev/null || fail "Debian ou Ubuntu est requis"

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
fi
[ -n "$PUBLIC_IP" ] || fail "impossible de déterminer l'IPv4 publique ; relancez avec PUBLIC_IP=..."

if [ -z "$CERTBOT_EMAIL" ]; then
  read -r -p "Adresse e-mail pour Let's Encrypt : " CERTBOT_EMAIL
fi
[ -n "$CERTBOT_EMAIL" ] || fail "une adresse e-mail est nécessaire pour le certificat"

read -r -s -p "Secret TURN (la même valeur que TURN_STATIC_AUTH_SECRET dans Replit) : " TURN_SECRET
printf '\n'
[ "${#TURN_SECRET}" -ge 32 ] || fail "le secret TURN doit contenir au moins 32 caractères"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING_SECRET="$(sed -n 's/^static-auth-secret=//p' "$CONFIG_FILE" | head -n 1)"
  [ "$EXISTING_SECRET" = "$TURN_SECRET" ] ||
    fail "$CONFIG_FILE existe avec un autre secret ; refuse de l'écraser"

  check_existing_config_value() {
    local key="$1"
    local expected="$2"
    local actual
    actual="$(sed -n "s/^${key}=//p" "$CONFIG_FILE" | head -n 1)"
    [ "$actual" = "$expected" ] || CONFIG_MISMATCHES+=("$key")
  }

  check_existing_config_value "external-ip" "$PUBLIC_IP"
  check_existing_config_value "realm" "$TURN_DOMAIN"
  check_existing_config_value "server-name" "$TURN_DOMAIN"
  check_existing_config_value "cert" "$CERT_DIR/fullchain.pem"
  check_existing_config_value "pkey" "$CERT_DIR/privkey.pem"

  if [ "${#CONFIG_MISMATCHES[@]}" -ne 0 ]; then
    [ "$TURN_MIGRATION_CONFIRM" = "MIGRATE_TURN_CONFIGURATION" ] ||
      fail "$CONFIG_FILE est incompatible avec les paramètres demandés (${CONFIG_MISMATCHES[*]}) ; relancez volontairement avec TURN_MIGRATION_CONFIRM=MIGRATE_TURN_CONFIGURATION"
    MIGRATION_MODE=1
    info "migration explicitement confirmée pour : ${CONFIG_MISMATCHES[*]}"
  fi
fi

title "1. Vérification DNS"
apt-get update -qq
apt-get install -y -qq ca-certificates curl dnsutils ufw coturn certbot

DNS_IP="$(dig +short "$TURN_DOMAIN" A | tail -n 1)"
[ "$DNS_IP" = "$PUBLIC_IP" ] || fail "$TURN_DOMAIN pointe vers ${DNS_IP:-aucune adresse}, attendu $PUBLIC_IP"
ok "$TURN_DOMAIN -> $PUBLIC_IP"

title "2. Pare-feu"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'Certificats Let'\''s Encrypt'
ufw allow 3478/tcp comment 'TURN'
ufw allow 3478/udp comment 'TURN'
ufw allow 5349/tcp comment 'TURN TLS'
ufw allow 5349/udp comment 'TURN DTLS'
ufw allow 49160:49200/udp comment 'Relais TURN'
ufw --force enable
ok "ports Coturn ouverts"

title "3. Certificat TLS"
mkdir -p "$CERT_DIR"
if [ ! -r "$CERT_DIR/fullchain.pem" ] || [ ! -r "$CERT_DIR/privkey.pem" ]; then
  systemctl stop coturn 2>/dev/null || true
  certbot certonly --standalone \
    --non-interactive \
    --agree-tos \
    --no-eff-email \
    --email "$CERTBOT_EMAIL" \
    -d "$TURN_DOMAIN"
  ok "certificat Let's Encrypt obtenu"
else
  ok "certificat existant conservé"
fi

title "4. Configuration Coturn"
write_config() {
  local destination="$1"
  cat > "$destination" <<EOF
listening-ip=0.0.0.0
external-ip=$PUBLIC_IP
listening-port=3478
tls-listening-port=5349

realm=$TURN_DOMAIN
server-name=$TURN_DOMAIN
use-auth-secret
static-auth-secret=$TURN_SECRET

cert=$CERT_DIR/fullchain.pem
pkey=$CERT_DIR/privkey.pem

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
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

user-quota=12
total-quota=1200
max-bps=1000000
log-file=syslog
simple-log
EOF
  chmod 600 "$destination"
}

validate_candidate_config() {
  local candidate="$1"
  local key expected actual
  while IFS='|' read -r key expected; do
    actual="$(sed -n "s/^${key}=//p" "$candidate" | head -n 1)"
    [ "$actual" = "$expected" ] ||
      fail "la configuration candidate est invalide pour $key ; configuration existante conservée"
  done <<EOF
external-ip|$PUBLIC_IP
realm|$TURN_DOMAIN
server-name|$TURN_DOMAIN
static-auth-secret|$TURN_SECRET
cert|$CERT_DIR/fullchain.pem
pkey|$CERT_DIR/privkey.pem
EOF
  [ -r "$CERT_DIR/fullchain.pem" ] && [ -r "$CERT_DIR/privkey.pem" ] ||
    fail "le nouveau certificat ou sa clé privée est illisible ; configuration existante conservée"
}

if [ "$MIGRATION_MODE" -eq 1 ]; then
  CONFIG_CANDIDATE="$(mktemp "${CONFIG_FILE}.candidate.XXXXXX")"
  trap 'rm -f "${CONFIG_CANDIDATE:-}"' EXIT
  write_config "$CONFIG_CANDIDATE"
  validate_candidate_config "$CONFIG_CANDIDATE"
  CONFIG_BACKUP="${CONFIG_FILE}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$CONFIG_FILE" "$CONFIG_BACKUP"
  chmod 600 "$CONFIG_BACKUP"
  mv -f "$CONFIG_CANDIDATE" "$CONFIG_FILE"
  CONFIG_CANDIDATE=""
  ok "configuration migrée après validation ; sauvegarde : $CONFIG_BACKUP"
elif [ -f "$CONFIG_FILE" ]; then
  ok "configuration existante conservée"
else
  write_config "$CONFIG_FILE"
  validate_candidate_config "$CONFIG_FILE"
  ok "configuration Coturn créée"
fi

mkdir -p "$(dirname "$DEFAULT_FILE")" "$(dirname "$RENEWAL_FILE")"
printf 'TURNSERVER_ENABLED=1\n' > "$DEFAULT_FILE"
cat > "$RENEWAL_FILE" <<'EOF'
17 4 * * * root certbot renew --quiet --deploy-hook "/bin/systemctl reload coturn"
EOF
chmod 644 "$RENEWAL_FILE"

title "5. Démarrage et contrôle"
if [ "$MIGRATION_MODE" -eq 1 ]; then
  systemctl enable coturn
  systemctl restart coturn
else
  systemctl enable --now coturn
  systemctl reload coturn
fi
systemctl is-active --quiet coturn || {
  journalctl -u coturn -n 60 --no-pager
  fail "Coturn ne démarre pas"
}
ok "Coturn est actif"

if command -v ss >/dev/null; then
  ss -lntup | grep -E ':(3478|5349)\b' || fail "aucun port Coturn en écoute"
fi

cat <<EOF

Installation terminée.

Relais TURN : $TURN_DOMAIN
Application : conserver TURN_HOST=$TURN_DOMAIN dans les Secrets Replit
Authentification : conserver TURN_STATIC_AUTH_SECRET avec le secret saisi ici
Port TLS 443 : non annoncé ; Coturn ne l'écoute pas dans cette installation

Test applicatif après redémarrage de l'API NovaLuth :
  curl -s https://novaluth.com/api/meet/ice | jq .

Le secret n'est pas affiché et n'est pas enregistré par ce script dans un
fichier séparé. Pour activer un jour le port 443, configurer d'abord un
écouteur Coturn réel, puis définir TURN_TLS_443=true dans Replit.
EOF