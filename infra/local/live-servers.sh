#!/usr/bin/env bash
# Real clamd (native, unprivileged) and real Dovecot + Postfix (a container, see mailserver/Dockerfile) for the live tests,
# on localhost high ports. Needs: brew install clamav, and a running Docker. `stop` ends everything this started.
#
#   infra/local/live-servers.sh start <dir>   # configures and starts both; freshclam downloads signatures once
#   infra/local/live-servers.sh start-clamd|start-mail <dir>   # just one of them
#   infra/local/live-servers.sh env <dir>     # prints the exports the live tests read
#   infra/local/live-servers.sh stop <dir>
set -euo pipefail

cmd=${1:?usage: live-servers.sh start|env|stop <dir>}
dir=${2:?usage: live-servers.sh start|env|stop <dir>}
mkdir -p "$dir"
dir=$(cd "$dir" && pwd -P)
brew_prefix=$(brew --prefix)
clamd_port=${CLAMD_TEST_PORT:-3240}
imaps_port=${IMAP_TEST_PORT:-3250}
imap_port=${IMAP_TEST_STARTTLS_PORT:-3251}
pop3s_port=${POP3_TEST_PORT:-3252}
submission_port=${SMTP_TEST_STARTTLS_PORT:-3253}
submissions_port=${SMTP_TEST_PORT:-3254}
# Test-only passwords. They guard nothing: the server listens on loopback and holds synthetic mail.
pass="live-test-password"

print_env() {
  cat <<OUT
export CLAMD_TEST_HOST=127.0.0.1 CLAMD_TEST_PORT=$clamd_port CLAMD_TEST_STREAM_MAX_BYTES=$((4 * 1024 * 1024)) CLAMD_TEST_MAX_FILE_BYTES=$((2 * 1024 * 1024))
export IMAP_TEST_HOST=127.0.0.1 IMAP_TEST_PORT=$imaps_port IMAP_TEST_STARTTLS_PORT=$imap_port IMAP_TEST_SERVERNAME=localhost IMAP_TEST_CA_FILE=$dir/mailserver/server.crt IMAP_TEST_PASS=$pass
export POP3_TEST_PORT=$pop3s_port SMTP_TEST_PORT=$submissions_port SMTP_TEST_STARTTLS_PORT=$submission_port
OUT
}

start_clamd() {
  local c=$dir/clamav
  mkdir -p "$c/db" "$c/log"
  cat > "$c/freshclam.conf" <<CONF
DatabaseDirectory $c/db
UpdateLogFile $c/log/freshclam.log
DatabaseMirror database.clamav.net
CONF
  # StreamMaxLength and MaxFileSize are small so the live test can cross them cheaply. AlertExceedsMax is required in any
  # deployment: without it clamd answers OK for what it refused to read.
  cat > "$c/clamd.conf" <<CONF
DatabaseDirectory $c/db
LogFile $c/log/clamd.log
LogTime yes
PidFile $c/clamd.pid
TemporaryDirectory $c
TCPSocket $clamd_port
TCPAddr 127.0.0.1
Foreground yes
StreamMaxLength 4M
MaxFileSize 2M
MaxScanSize 8M
AlertExceedsMax yes
CONF
  [ -f "$c/db/daily.cvd" ] || [ -f "$c/db/daily.cld" ] || "$brew_prefix/bin/freshclam" --config-file="$c/freshclam.conf" --user="$(id -un)"
  "$brew_prefix/opt/clamav/sbin/clamd" --config-file="$c/clamd.conf" > "$c/log/clamd.stdout" 2>&1 &
  echo "clamd starting on 127.0.0.1:$clamd_port (loads signatures for about 20 seconds)"
}

start_mail() {
  local m=$dir/mailserver repo
  repo=$(cd "$(dirname "$0")" && pwd -P)
  mkdir -p "$m"
  docker build -q -t aegis-live-mailserver "$repo/mailserver" >/dev/null
  docker rm -f aegis-live-mail >/dev/null 2>&1 || true
  docker run -d --name aegis-live-mail -e MAIL_TEST_PASSWORD="$pass" \
    -p "127.0.0.1:$imaps_port:993" -p "127.0.0.1:$imap_port:143" -p "127.0.0.1:$pop3s_port:995" \
    -p "127.0.0.1:$submission_port:587" -p "127.0.0.1:$submissions_port:465" aegis-live-mailserver >/dev/null
  for _ in $(seq 1 50); do docker cp aegis-live-mail:/etc/mail-test/server.crt "$m/server.crt" >/dev/null 2>&1 && break; sleep 0.2; done
  echo "mail server up: imaps $imaps_port, imap+starttls $imap_port, pop3s $pop3s_port, submission+starttls $submission_port, smtps $submissions_port"
}

case "$cmd" in
  start) start_clamd; start_mail; print_env ;;
  start-clamd) start_clamd; print_env ;;
  start-mail) start_mail; print_env ;;
  env) print_env ;;
  stop)
    docker rm -f aegis-live-mail >/dev/null 2>&1 || true
    [ -f "$dir/clamav/clamd.pid" ] && kill "$(cat "$dir/clamav/clamd.pid")" 2>/dev/null || true
    ;;
  *) echo "usage: live-servers.sh start|env|stop <dir>" >&2; exit 1 ;;
esac
