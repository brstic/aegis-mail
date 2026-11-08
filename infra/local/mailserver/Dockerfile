# Real Dovecot and Postfix for the live tests. Loopback only, synthetic mail, test passwords: never deploy this.
# Runs in Linux because Homebrew Dovecot 2.4.5 on macOS drops every TLS session right after login.
FROM debian:trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      dovecot-imapd dovecot-pop3d dovecot-lmtpd postfix openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 5000 -d /var/vmail -m vmail
COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY main.cf /etc/postfix/main.cf
COPY entry.sh /entry.sh
EXPOSE 143 993 995 587 465
CMD ["/bin/bash", "/entry.sh"]
