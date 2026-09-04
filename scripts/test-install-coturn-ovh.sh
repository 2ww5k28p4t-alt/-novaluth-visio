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

run_installer() {
  local root="$1"
  local dns_ip="$2"
  local output="$3"
  set +e
  printf '%s\n' "$secret" |
    env \
      PATH="$mock_bin:$PATH" \
      MOCK_COMMAND_LOG="$command_log" \
      MOCK_DNS_IP="$dns_ip" \
      NOVALUTH_COTURN_TEST_MODE=1 \
      NOVALUTH_COTURN_TEST_ROOT="$root" \
      TURN_DOMAIN=turn.test.invalid \
      PUBLIC_IP=203.0.113.10 \
      CERTBOT_EMAIL=admin@example.test \
      bash "$installer" >"$output" 2>&1
  local status=$?
  set -e
  return "$status"
}

printf '1/3 Vérification statique de l’installateur\n'
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
for command in apt-get ufw systemctl certbot journalctl; do
  cat >"$mock_bin/$command" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"${MOCK_COMMAND_LOG:?}"
exit 0
EOF
done
chmod +x "$mock_bin"/*

printf '2/3 Refus d’un DNS incorrect sans accès réseau\n'
dns_root="$tmp_dir/dns-root"
dns_output="$tmp_dir/dns-output.log"
if run_installer "$dns_root" "198.51.100.25" "$dns_output"; then
  fail "l’installateur a accepté un DNS incorrect"
fi
assert_contains "$dns_output" "pointe vers 198.51.100.25, attendu 203.0.113.10"
assert_not_contains "$dns_output" "$secret"
[ ! -e "$dns_root/etc/turnserver.conf" ] ||
  fail "une configuration a été écrite malgré le refus DNS"

printf '3/3 Refus d’écraser un secret TURN différent\n'
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

printf 'PASS: garde-fous de l’installateur Coturn validés sans serveur ni secret réel.\n'