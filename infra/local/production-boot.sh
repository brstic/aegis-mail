#!/bin/zsh
# Boots the real web and worker in NODE_ENV=production with demo mode off, on their own database logins, with the AWS KMS provider
# pointed at a local server speaking the KMS protocol. Checks what the running system does, including what it refuses.
# It isn't a deployment: there's no TLS, no real KMS, no real mail relay and no real mailbox.
#   infra/local/production-boot.sh <scratch dir>
set -u
S=${1:?a scratch directory}
ROOT=${0:A:h:h:h}
DB=aegis_prodboot
PORT=3299
ADMIN=postgres://localhost:5432/$DB
ORIGIN=http://localhost:$PORT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: wanted $3, got $2"; fail=1; fi; }

cd "$ROOT"
DATABASE_URL=$ADMIN pnpm -s db:reset > "$S/boot-migrate.log" 2>&1 || { echo "migrate failed"; tail -5 "$S/boot-migrate.log"; exit 1; }
infra/local/kms-server.sh start "$S"
/bin/sleep 4
export AWS_ENDPOINT_URL_KMS=http://127.0.0.1:3241 AWS_ACCESS_KEY_ID=local-test AWS_SECRET_ACCESS_KEY=local-test AWS_REGION=eu-west-1
KEY=$(cd packages/cryptography && node --input-type=module -e "
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
const r = await new KMSClient({ region: 'eu-west-1' }).send(new CreateKeyCommand({ Description: 'production boot check' }));
console.log(r.KeyMetadata.KeyId);")
[ -n "$KEY" ] || { echo "no KMS key"; infra/local/kms-server.sh stop "$S"; exit 1; }

common=(NODE_ENV=production DEMO_MODE=false DATABASE_URL=$ADMIN DATABASE_URL_WEB=postgres://aegis_web_login@localhost:5432/$DB DATABASE_URL_WORKER=postgres://aegis_worker_login@localhost:5432/$DB APP_ORIGIN=$ORIGIN WEBAUTHN_RP_ID=localhost)

# A build with no KMS configured has to refuse, not fall back.
(cd apps/web && env "${common[@]}" pnpm exec next build > "$S/boot-build.log" 2>&1) || { echo "build failed"; grep -iE "error" "$S/boot-build.log" | head -5; infra/local/kms-server.sh stop "$S"; exit 1; }
(cd apps/worker && env "${common[@]}" AEGIS_DEV_ROOT_KEY=$(head -c 32 /dev/urandom | base64) timeout 25 pnpm exec tsx src/main.ts > "$S/boot-devkms.log" 2>&1); code=$?
if grep -q "isn't allowed in production" "$S/boot-devkms.log"; then echo "ok    worker refuses the dev KMS in production"; else echo "FAIL  worker with the dev KMS: exit $code"; tail -3 "$S/boot-devkms.log" | cut -c1-200; fail=1; fi

# Nor can a worker run with nowhere to ship the deletion log.
(cd apps/worker && env "${common[@]}" AWS_KMS_KEY_ID=$KEY timeout 25 pnpm exec tsx src/main.ts > "$S/boot-nolog.log" 2>&1); code=$?
if grep -q "AEGIS_DELETION_LOG_PATH is required in production" "$S/boot-nolog.log"; then echo "ok    worker refuses to run without a deletion log in production"; else echo "FAIL  worker with no deletion log: exit $code"; tail -3 "$S/boot-nolog.log"; fail=1; fi

(cd apps/worker && env "${common[@]}" AWS_KMS_KEY_ID=$KEY AEGIS_DELETION_LOG_PATH=$S/deletions.jsonl pnpm exec tsx src/main.ts > "$S/boot-worker.log" 2>&1) &
WORKER=$!
(cd apps/web && env "${common[@]}" AWS_KMS_KEY_ID=$KEY pnpm exec next start -p $PORT > "$S/boot-web.log" 2>&1) &
WEB=$!
for i in {1..60}; do [ "$(curl -s -o /dev/null -w '%{http_code}' $ORIGIN/api/v1/health)" = "200" ] && break; /bin/sleep 1; done

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
J=(-H "Origin: $ORIGIN" -H 'Content-Type: application/json')
check "health" "$(code $ORIGIN/api/v1/health)" 200
check "sign-in page" "$(code $ORIGIN/sign-in)" 200
check "the dev outbox isn't there" "$(code $ORIGIN/dev/outbox)" 404
check "the demo sign-in isn't there" "$(code "${J[@]}" -d '{}' $ORIGIN/api/v1/demo/signin)" 404
check "sign-up works" "$(code "${J[@]}" -c "$S/boot.cj" -d '{"email":"owner@boot.example","password":"correct-horse-battery-staple","name":"Owner","workspaceKind":"personal"}' $ORIGIN/api/v1/auth/signup)" 200
check "signed in" "$(code -b "$S/boot.cj" $ORIGIN/api/v1/me)" 200
check "simulated mail is refused, even signed in" "$(code "${J[@]}" -b "$S/boot.cj" -d '{}' $ORIGIN/api/v1/demo/simulate)" 409
check "wrong origin is refused" "$(code -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -b "$S/boot.cj" -d '{}' $ORIGIN/api/v1/auth/signout)" 403
csp=$(curl -sI $ORIGIN/sign-in | grep -ci 'content-security-policy')
check "pages carry a CSP" "$csp" 1
# Keys are made the first time something is sealed. Setting up an authenticator seals its secret.
check "sealing works through the KMS provider" "$(code "${J[@]}" -b "$S/boot.cj" -d '{"password":"correct-horse-battery-staple"}' $ORIGIN/api/v1/auth/totp/begin)" 200
psql -At -c "SELECT key_class, kms_id, length(wrapped) FROM tenant_keys" $DB | head -3
check "tenant keys are wrapped by the KMS provider" "$(psql -At -c "SELECT count(*) > 0 AND bool_and(kms_id LIKE 'aws-kms:%') FROM tenant_keys" $DB)" t
check "the web login can't read credentials" "$(psql -At "postgres://aegis_web_login@localhost:5432/$DB" -c 'SELECT 1 FROM credential_envelopes LIMIT 1' 2>&1 | grep -c 'permission denied')" 1

kill $WEB $WORKER 2>/dev/null
# Only what's on this script's own port. A pattern match here could stop someone else's server on the same machine.
lsof -nP -t -iTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null
infra/local/kms-server.sh stop "$S"
wait 2>/dev/null
grep -ciE "unhandled|uncaught" "$S/boot-web.log" "$S/boot-worker.log"
dropdb --if-exists $DB
echo "exit=$fail"
exit $fail
