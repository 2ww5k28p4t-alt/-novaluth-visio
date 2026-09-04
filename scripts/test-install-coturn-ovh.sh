#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$workspace_root/scripts/install-coturn-ovh.sh"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/novaluth-coturn-test.XXXXXX")"
mock_bin="$tmp_dir/bin"
command_log="$tmp_dir/commands.log"
secret='test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" ||
    fail "« $expected » absent de $file"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fiq -- "$unexpected" "$file"; then
    fail "« $unexpected » ne doit pas apparaître dans $file"
  fi
}

assert_count() {
  local file="$1"
  local expected="$2"
  local text="$3"
  local actual
  actual="$(grep -Fc -- "$text" "$file" || true)"
  [ "$actual" -eq "$expected" ] ||
    fail "« $text » apparaît $actual fois dans $file, attendu : $expected"
}

run_installer() {
  local root="$1"
  local dns_ip="$2"
  local output="$3"
  local public_ip="${4:-203.0.113.10}"
  local turn_domain="${5:-turn.test.invalid}"
  local migration_confirm="${6:-}"
  set +e
  printf '%s\n' "$secret" |
    env \
      PATH="$mock_bin:$PATH" \
      MOCK_COMMAND_LOG="$command_log" \
      MOCK_DNS_IP="$dns_ip" \
      NOVALUTH_COTURN_TEST_MODE=1 \
      NOVALUTH_COTURN_TEST_ROOT="$root" \
      TURN_DOMAIN="$turn_domain" \
      PUBLIC_IP="$public_ip" \
      CERTBOT_EMAIL=admin@example.test \
      TURN_MIGRATION_CONFIRM="$migration_confirm" \
      bash "$installer" >"$output" 2>&1
  local status=$?
  set -e
  return "$status"
}

printf '1/6 Vérification statique de l’installateur\n'
bash -n "$installer"
assert_contains "$installer" "set -euo pipefail"
assert_contains "$installer" "umask 077"
assert_contains "$installer" "ufw allow 22/tcp"
assert_contains "$installer" "ufw allow 3478/tcp"
assert_contains "$installer" "ufw allow 3478/udp"
assert_contains "$installer" "ufw allow 5349/tcp"
assert_contains "$installer" "ufw allow 5349/udp"
assert_contains "$installer" "ufw allow 49160:49200/udp"
assert_contains "$installer" "listening-port=3478"
assert_contains "$installer" "tls-listening-port=5349"
assert_contains "$installer" "min-port=49160"
assert_contains "$installer" "max-port=49200"
assert_not_contains "$installer" "docker"
assert_not_contains "$installer" "users.json"
assert_not_contains "$installer" "server.js"
assert_not_contains "$installer" "npm install"
assert_not_contains "$installer" "pnpm install"

mkdir -p "$mock_bin"
cat >"$mock_bin/id" <<'EOF'
#!/usr/bin/env bash
printf '0\n'
EOF
cat >"$mock_bin/dig" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${MOCK_DNS_IP:?}"
EOF
for command in apt-get ufw systemctl journalctl; do
  cat >"$mock_bin/$command" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"${MOCK_COMMAND_LOG:?}"
exit 0
EOF
done
cat >"$mock_bin/certbot" <<'EOF'
#!/usr/bin/env bash
printf 'certbot %s\n' "$*" >>"${MOCK_COMMAND_LOG:?}"

if [[ "${1:-}" == "certonly" ]]; then
  domain=""
  while (($# > 0)); do
    if [[ "$1" == "-d" ]]; then
      shift
      domain="${1:-}"
      break
    fi
    shift
  done
  [[ -n "$domain" ]]
  cert_dir="${NOVALUTH_COTURN_TEST_ROOT:?}/etc/letsencrypt/live/$domain"
  mkdir -p "$cert_dir"
  printf 'simulated certificate\n' >"$cert_dir/fullchain.pem"
  printf 'simulated private key\n' >"$cert_dir/privkey.pem"
fi
EOF
cat >"$mock_bin/ss" <<'EOF'
#!/usr/bin/env bash
printf 'ss %s\n' "$*" >>"${MOCK_COMMAND_LOG:?}"
printf 'udp UNCONN 0 0 0.0.0.0:3478 0.0.0.0:*\n'
printf 'tcp LISTEN 0 128 0.0.0.0:5349 0.0.0.0:*\n'
EOF
chmod +x "$mock_bin"/*

printf '2/6 Refus d’un DNS incorrect sans accès réseau\n'
dns_root="$tmp_dir/dns-root"
dns_output="$tmp_dir/dns-output.log"
if run_installer "$dns_root" "198.51.100.25" "$dns_output"; then
  fail "l’installateur a accepté un DNS incorrect"
fi
assert_contains "$dns_output" "pointe vers 198.51.100.25, attendu 203.0.113.10"
assert_not_contains "$dns_output" "$secret"
[ ! -e "$dns_root/etc/turnserver.conf" ] ||
  fail "une configuration a été écrite malgré le refus DNS"

printf '3/6 Refus d’écraser un secret TURN différent\n'
config_root="$tmp_dir/config-root"
config_file="$config_root/etc/turnserver.conf"
cert_dir="$config_root/etc/letsencrypt/live/turn.test.invalid"
mkdir -p "$(dirname "$config_file")" "$cert_dir"
printf 'static-auth-secret=existing-secret-that-must-stay\n' >"$config_file"
printf 'certificate\n' >"$cert_dir/fullchain.pem"
printf 'private-key\n' >"$cert_dir/privkey.pem"
before="$(cat "$config_file")"
config_output="$tmp_dir/config-output.log"
if run_installer "$config_root" "203.0.113.10" "$config_output"; then
  fail "l’installateur a écrasé une configuration avec un autre secret"
fi
assert_contains "$config_output" "existe avec un autre secret ; refuse de l'écraser"
assert_not_contains "$config_output" "$secret"
[ "$(cat "$config_file")" = "$before" ] ||
  fail "la configuration existante a été modifiée"
[ ! -e "$config_root/etc/default/coturn" ] ||
  fail "Coturn a été activé malgré le conflit de secret"

printf '4/6 Installation complète et refus des paramètres obsolètes\n'
success_root="$tmp_dir/success-root"
first_output="$tmp_dir/success-first.log"
success_config="$success_root/etc/turnserver.conf"
success_default="$success_root/etc/default/coturn"
success_renewal="$success_root/etc/cron.d/novaluth-coturn-cert"
success_cert_dir="$success_root/etc/letsencrypt/live/turn.test.invalid"
: >"$command_log"

run_installer "$success_root" "203.0.113.10" "$first_output" ||
  fail "la première installation simulée a échoué"
assert_not_contains "$first_output" "$secret"
assert_contains "$success_config" "external-ip=203.0.113.10"
assert_contains "$success_config" "realm=turn.test.invalid"
assert_contains "$success_config" "static-auth-secret=$secret"
assert_contains "$success_config" "cert=$success_cert_dir/fullchain.pem"
assert_contains "$success_config" "pkey=$success_cert_dir/privkey.pem"
assert_contains "$success_config" "min-port=49160"
assert_contains "$success_config" "max-port=49200"
assert_contains "$success_default" "TURNSERVER_ENABLED=1"
assert_contains "$success_renewal" 'certbot renew --quiet --deploy-hook "/bin/systemctl reload coturn"'
[ "$(stat -c '%a' "$success_config")" = "600" ] ||
  fail "la configuration Coturn n’a pas les permissions 600"
[ "$(stat -c '%a' "$success_default")" = "600" ] ||
  fail "le fichier d’activation Coturn n’a pas les permissions 600"
[ "$(stat -c '%a' "$success_renewal")" = "644" ] ||
  fail "la tâche de renouvellement n’a pas les permissions 644"
[ -r "$success_cert_dir/fullchain.pem" ] &&
  [ -r "$success_cert_dir/privkey.pem" ] ||
  fail "Certbot simulé n’a pas créé les deux fichiers du certificat"

cp "$success_config" "$tmp_dir/turnserver.conf.before-stale-ip"
stale_ip_output="$tmp_dir/stale-ip-output.log"
if run_installer "$success_root" "198.51.100.25" "$stale_ip_output" "198.51.100.25"; then
  fail "l’installateur a accepté une adresse external-ip obsolète"
fi
assert_contains "$stale_ip_output" "TURN_MIGRATION_CONFIRM=MIGRATE_TURN_CONFIGURATION"
assert_not_contains "$stale_ip_output" "$secret"
cmp -s "$tmp_dir/turnserver.conf.before-stale-ip" "$success_config" ||
  fail "le changement d’IP a modifié la configuration Coturn existante"

cp "$success_config" "$tmp_dir/turnserver.conf.before-stale-domain"
stale_domain_output="$tmp_dir/stale-domain-output.log"
if run_installer "$success_root" "203.0.113.10" "$stale_domain_output" "203.0.113.10" "turn-new.test.invalid"; then
  fail "l’installateur a accepté un domaine Coturn obsolète"
fi
assert_contains "$stale_domain_output" "TURN_MIGRATION_CONFIRM=MIGRATE_TURN_CONFIGURATION"
assert_not_contains "$stale_domain_output" "$secret"
cmp -s "$tmp_dir/turnserver.conf.before-stale-domain" "$success_config" ||
  fail "le changement de domaine a modifié la configuration Coturn existante"
[ ! -e "$success_root/etc/letsencrypt/live/turn-new.test.invalid" ] ||
  fail "le changement de domaine a créé des fichiers avant le refus"

printf '5/6 Migration confirmée avec sauvegarde et redémarrage\n'
migration_before="$tmp_dir/turnserver.conf.before-migration"
cp "$success_config" "$migration_before"
migration_output="$tmp_dir/migration-output.log"
run_installer "$success_root" "198.51.100.25" "$migration_output" \
  "198.51.100.25" "turn.test.invalid" "MIGRATE_TURN_CONFIGURATION" ||
  fail "la migration explicitement confirmée a échoué"
assert_contains "$migration_output" "migration explicitement confirmée pour : external-ip"
assert_contains "$migration_output" "configuration migrée après validation ; sauvegarde :"
assert_not_contains "$migration_output" "$secret"
assert_contains "$success_config" "external-ip=198.51.100.25"
migration_backup="$(find "$success_root/etc" -maxdepth 1 -name 'turnserver.conf.backup.*' -print -quit)"
[ -n "$migration_backup" ] || fail "la migration n’a créé aucune sauvegarde"
cmp -s "$migration_before" "$migration_backup" ||
  fail "la sauvegarde ne correspond pas à la configuration antérieure"
[ "$(stat -c '%a' "$migration_backup")" = "600" ] ||
  fail "la sauvegarde Coturn n’a pas les permissions 600"
assert_contains "$command_log" "systemctl restart coturn"

printf '6/6 Réinstallation idempotente avec des paramètres identiques\n'
second_output="$tmp_dir/success-second.log"
cp "$success_config" "$tmp_dir/turnserver.conf.before-reinstall"
run_installer "$success_root" "198.51.100.25" "$second_output" "198.51.100.25" ||
  fail "la réinstallation simulée avec le même secret a échoué"
assert_contains "$second_output" "configuration existante conservée"
assert_contains "$second_output" "certificat existant conservé"
assert_not_contains "$second_output" "$secret"
cmp -s "$tmp_dir/turnserver.conf.before-reinstall" "$success_config" ||
  fail "la réinstallation a modifié la configuration Coturn existante"
assert_count "$success_config" 1 "static-auth-secret=$secret"
assert_count "$success_default" 1 "TURNSERVER_ENABLED=1"
assert_count "$success_renewal" 1 "certbot renew --quiet"

assert_count "$command_log" 1 "certbot certonly"
assert_count "$command_log" 2 "systemctl enable --now coturn"
assert_count "$command_log" 2 "systemctl reload coturn"
assert_count "$command_log" 3 "systemctl is-active --quiet coturn"
assert_count "$command_log" 3 "ss -lntup"
assert_not_contains "$command_log" "$secret"

printf 'PASS: installation et réinstallation Coturn validées sans serveur ni secret réel.\n'