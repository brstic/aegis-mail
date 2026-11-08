#!/bin/zsh
# Restores a backup into a brand-new Postgres cluster, as after losing the old one, then reads mail through the real platform code on the
# app's own login. restore-drill.test.ts restores within one cluster, where roles already exist, so it can't show this works.
#   infra/local/restore-new-cluster.sh <scratch dir> [source database url] [email of a user with mail]
set -u
S=${1:?a scratch directory}
SRC=${2:-postgres://localhost:5432/aegis_dev}
ROOT=${0:A:h:h:h}
C=$S/new-cluster
PORT=3242
DB=aegis_restored
NEW=postgres://localhost:$PORT
fail=0
cd "$ROOT"

pg_ctl -D "$C" stop -m fast > /dev/null 2>&1
[ -d "$C" ] && find "$C" -mindepth 1 -delete && rmdir "$C"
initdb -D "$C" -A trust -E UTF8 > "$S/initdb.log" 2>&1 || { echo "initdb failed"; exit 1; }
pg_ctl -D "$C" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -l "$S/new-cluster.log" -w start > /dev/null || { echo "start failed"; exit 1; }

pg_dump -Fc -f "$S/full.dump" "$SRC" || fail=1
# Roles live outside any database, so a pg_dump doesn't contain them. A real backup has to include this too.
pg_dumpall --roles-only -d "$SRC" | grep -E "aegis_" | grep -vE "^--" > "$S/roles.sql"
echo "roles in the backup: $(grep -c '^CREATE ROLE' "$S/roles.sql")"
psql -q -v ON_ERROR_STOP=0 -d "$NEW/postgres" -f "$S/roles.sql" > "$S/roles.log" 2>&1
psql -q -d "$NEW/postgres" -c "CREATE DATABASE $DB"
# Ownership has to survive: definer functions depend on who owns them.
pg_restore --exit-on-error -d "$NEW/$DB" "$S/full.dump" > "$S/restore.log" 2>&1 && echo "ok    restored with ownership intact" || { echo "FAIL  restore"; tail -4 "$S/restore.log" | cut -c1-200; fail=1; }

DEMO_MODE=true DATABASE_URL="$NEW/$DB" DATABASE_URL_WEB="postgres://aegis_web_login@localhost:$PORT/$DB" pnpm -s exec tsx packages/platform/src/cli/restore-check.ts "${3:-morgan@demo.aegis.example}" > "$S/restore-check.log" 2>&1
if grep -q "^read-ok" "$S/restore-check.log"; then echo "ok    mail read through the web login: $(grep '^read-ok' "$S/restore-check.log")"; else echo "FAIL  reading mail after restore"; grep -vE '^\{"at"' "$S/restore-check.log" | tail -4 | cut -c1-220; fail=1; fi

psql -At "postgres://aegis_web_login@localhost:$PORT/$DB" -c "SELECT 1 FROM credential_envelopes LIMIT 1" 2>&1 | grep -q "permission denied" && echo "ok    role boundaries survived: the web login still can't read credentials" || { echo "FAIL  web login can read credentials"; fail=1; }
owner=$(psql -At -d "$NEW/$DB" -c "SELECT r.rolname FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='op' AND f.proname='cli_grant'")
[ "$owner" = "aegis_operator_definer" ] && echo "ok    definer functions kept their owner" || { echo "FAIL  definer owner is $owner"; fail=1; }

pg_ctl -D "$C" stop -m fast > /dev/null 2>&1
find "$C" -mindepth 1 -delete && rmdir "$C"
find "$S" -maxdepth 1 \( -name 'full.dump' -o -name 'roles.sql' \) -delete
echo "exit=$fail"
exit $fail
