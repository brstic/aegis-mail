#!/bin/sh
# Writes the .env for compose.staging.yml (a public demo site) on the host, once. It never overwrites one: the root key in it is what
# the demo data is sealed under.
#   infra/docker/staging-env.sh <path to .env> <hostname> <loopback port>
set -eu
FILE=${1:?path to .env}
HOST=${2:?hostname}
PORT=${3:?port}
[ -e "$FILE" ] && { echo "$FILE already exists. Leaving it alone."; exit 0; }
umask 077
{
  echo "STAGING_HOST=$HOST"
  echo "AEGIS_WEB_PORT=$PORT"
  echo "AEGIS_DEV_ROOT_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  echo "POSTGRES_PASSWORD=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "AEGIS_WEB_DB_PASSWORD=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "AEGIS_WORKER_DB_PASSWORD=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
} > "$FILE"
echo "Wrote $FILE"
