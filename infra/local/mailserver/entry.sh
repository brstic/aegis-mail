#!/bin/bash
set -euo pipefail
conf=/etc/mail-test
mkdir -p "$conf"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$conf/server.key" -out "$conf/server.crt" 2>/dev/null
chmod 640 "$conf/server.key"; chgrp dovecot "$conf/server.key"
: > "$conf/passwd"; : > "$conf/vmailbox"; : > "$conf/logins"
for u in imaptest pop3test platformtest smtpsender smtprcpt smtpbcc; do
  echo "$u@example.net:{PLAIN}${MAIL_TEST_PASSWORD}::::::" >> "$conf/passwd"
  echo "$u@example.net OK" >> "$conf/vmailbox"
  echo "$u@example.net $u@example.net" >> "$conf/logins"
done
chmod 644 "$conf/vmailbox" "$conf/logins"
cat >> /etc/postfix/master.cf <<CONF
submission inet n - n - - smtpd
  -o smtpd_tls_security_level=encrypt
smtps inet n - n - - smtpd
  -o smtpd_tls_wrappermode=yes
CONF
sed -i 's/^\(smtp \+inet.*\)$/#\1/' /etc/postfix/master.cf
mkdir -p /var/spool/postfix/private; chown postfix /var/spool/postfix/private
dovecot -F &
for _ in $(seq 1 50); do [ -S /var/spool/postfix/private/auth ] && break; sleep 0.1; done
postfix start-fg &
wait -n
